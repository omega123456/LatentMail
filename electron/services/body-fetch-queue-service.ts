/**
 * BodyFetchQueueService — dedicated per-account queue for body-fetch operations.
 *
 * Responsibilities:
 * - Maintains one fastq instance per account (concurrency 1) so body fetches
 *   are serialized per account without contending with the main mail queue.
 * - Owns a dedicated ImapFlow connection per account (lazy creation), keyed by
 *   accountId. The connection is created via ImapService.createDedicatedConnection()
 *   with logTag 'BODYFETCH' so log lines are clearly distinguishable.
 * - Delegates actual body fetching to BodyPrefetchService.fetchAndStoreBodies(),
 *   passing the dedicated client so it bypasses the shared IMAP connection pool.
 * - Schedules incremental vector indexing via EmbeddingService after each
 *   successful fetch batch (same pattern as MailQueueService.processBodyFetch()).
 * - Emits 'body-queue:update' push events to all renderer windows so the UI
 *   can display body-fetch queue status. (Phase 2 will add the IPC_EVENTS constant.)
 * - Provides dedup logic: callers pass a dedupKey; if an item with the same key
 *   is already pending or processing, the enqueue is skipped.
 * - No retry logic: failures mark items as 'failed' immediately (network blips
 *   are handled by the next periodic sync cycle re-enqueueing body fetches).
 * - No FolderLockManager usage: operates on [Gmail]/All Mail read-only via its
 *   own dedicated connection which does not interact with the shared IMAP pool.
 *
 * Connection lifecycle:
 * - Created lazily on the first enqueue for an account.
 * - On 'close' or 'error' events: removed from map and logged. Recreated lazily
 *   on the next enqueue (no auto-reconnect loop).
 * - disconnectAccount() / disconnectAll() allow graceful teardown on app exit
 *   or account removal.
 */

import { BrowserWindow } from 'electron';
import { ImapFlow } from 'imapflow';
import { DateTime } from 'luxon';
import * as fastq from 'fastq';
import { randomUUID } from 'crypto';
import { LoggerService } from './logger-service';
import { ImapService } from './imap-service';
import { BodyPrefetchService } from './body-prefetch-service';
import { EmbeddingService } from './embedding-service';
import { IPC_EVENTS } from '../ipc/ipc-channels';
import type { QueueItem, QueueItemSnapshot } from './queue-types';

const log = LoggerService.getInstance();

// ---------------------------------------------------------------------------
// Internal work item type for the fastq worker function
// ---------------------------------------------------------------------------

/** The shape pushed into each account's fastq instance. */
interface BodyFetchWorkItem {
  queueId: string;
  accountId: number;
  emails: Array<{ xGmMsgId: string; xGmThrid: string }>;
  description: string;
}

// ---------------------------------------------------------------------------
// BodyFetchQueueService
// ---------------------------------------------------------------------------

export class BodyFetchQueueService {
  private static instance: BodyFetchQueueService;

  /** Per-account fastq instances (concurrency 1 each). */
  private queues = new Map<number, fastq.queueAsPromised<BodyFetchWorkItem>>();

  /** All items by queueId for lookup and status reporting. */
  private items = new Map<string, QueueItem>();

  /**
   * Active dedup keys — same pattern as MailQueueService.activeDedupKeys.
   * Maps dedupKey → queueId for items that are pending or processing.
   */
  private activeDedupKeys = new Map<string, string>();

  /**
   * Dedicated IMAP connections, keyed by accountId (numeric).
   * Created lazily on first enqueue; removed on close/error; recreated on next enqueue.
   */
  private dedicatedConnections = new Map<number, ImapFlow>();

  /**
   * When true, new connections are blocked and enqueued work items fail fast
   * so the fastq workers drain without creating new IMAP sessions.
   * Set via pause() / resume(); checked inside ensureDedicatedConnection().
   */
  private isPaused: boolean = false;

  /**
   * Monotonically increasing generation counter, incremented by resetForTesting().
   * Workers capture this at the start of execution and re-check it after the
   * ensureDedicatedConnection() and fetchAndStoreBodies() awaits.
   * If the counter has changed, quiesceAndRestore() has run and this worker is
   * stale — it abandons all further DB writes / event emissions to prevent
   * corrupting the next suite's state.
   *
   * NOT intended for production use.
   */
  private testGeneration = 0;

  private constructor() {}

  static getInstance(): BodyFetchQueueService {
    if (!BodyFetchQueueService.instance) {
      BodyFetchQueueService.instance = new BodyFetchQueueService();
    }
    return BodyFetchQueueService.instance;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Hard-reset the body-fetch queue for inter-suite test isolation.
   *
   * Synchronously kills all fastq workers, sets isPaused (so any in-flight worker
   * that calls ensureDedicatedConnection() after this point fails fast), clears all
   * tracking maps, and fire-and-forgets logout on every dedicated IMAP connection.
   *
   * Logout is NOT awaited — the ImapService shared connections are also being torn
   * down in parallel by quiesceAndRestore(), so the dedicated connections may already
   * be gone by the time logout() resolves.  Firing without awaiting keeps the reset
   * synchronous and avoids blocking the quiesceAndRestore() chain on a slow TCP
   * teardown.  Any in-flight worker that opened a dedicated connection will hit the
   * isPaused guard and log a "paused" error — that is the intended behaviour.
   *
   * The companion `resumeFromTesting()` call is NOT issued here — quiesceAndRestore()
   * keeps BodyFetchQueueService in "paused" state until seedTestAccount() calls
   * resumeFromTesting() at the start of the new suite.
   *
   * NOT intended for production use.
   */
  resetForTesting(): void {
    // 1. Increment the generation counter FIRST so any in-flight worker that calls
    //    ensureDedicatedConnection() or fetchAndStoreBodies() after this point can
    //    detect the suite boundary and bail out before writing to the restored DB.
    this.testGeneration++;

    // 2. Set isPaused FIRST so any in-flight worker that calls ensureDedicatedConnection()
    //    after this point throws immediately instead of creating a new IMAP session
    //    against the just-restored database.
    this.isPaused = true;

    // 2. Kill all fastq instances — prevents NEW items from being dispatched to workers.
    //    fastq.kill() does NOT abort in-flight workers; they continue but will hit the
    //    isPaused guard in ensureDedicatedConnection() and mark themselves as failed.
    for (const queue of this.queues.values()) {
      queue.kill();
    }
    this.queues.clear();

    // 3. Clear all in-memory tracking state.
    this.items.clear();
    this.activeDedupKeys.clear();

    // 4. Fire-and-forget logout on all dedicated connections, then clear the map.
    //    We do NOT await these — the shared IMAP connections are torn down in parallel
    //    by quiesceAndRestore() and client.logout() may never resolve if the TCP layer
    //    is already gone.  Clearing the map synchronously ensures no stale references
    //    survive into the new suite.
    for (const [accountId, client] of this.dedicatedConnections) {
      client.logout().catch(() => {
        // Best-effort — connection may already be gone
        log.debug(`[BodyFetchQueue] resetForTesting: logout error for account ${accountId} (ignored)`);
      });
    }
    this.dedicatedConnections.clear();

    log.debug('[BodyFetchQueue] resetForTesting: queue killed, state cleared, connections released');
  }

  /**
   * Lift the isPaused flag after a resetForTesting() call so the queue accepts
   * new enqueues and creates fresh IMAP connections lazily.
   *
   * Called by seedTestAccount() alongside MailQueueService.resumeFromTesting() and
   * SyncQueueBridge.resumeForTesting() so that all three services are unblocked at
   * the same point in the test lifecycle.
   *
   * NOT intended for production use.
   */
  resumeFromTesting(): void {
    this.isPaused = false;
    log.debug('[BodyFetchQueue] resumeFromTesting: queue unpaused');
  }

  /**
   * Pause the body-fetch queue.
   *
   * Sets the isPaused flag (so ensureDedicatedConnection() throws for any
   * in-flight or newly dispatched workers) and disconnects all dedicated IMAP
   * connections. New items can still be enqueued (they stay pending) but
   * workers will fail immediately until resume() is called.
   *
   * Called by SyncQueueBridge.pause() and SyncQueueBridge.stopForSleep().
   */
  async pause(): Promise<void> {
    this.isPaused = true;

    // Issue 3 fix: Cancel all pending items immediately on pause instead of letting
    // them fail with a "paused" error when the worker eventually runs.
    // Items currently 'processing' are left to fail naturally — they are mid-flight
    // and will hit the isPaused guard in ensureDedicatedConnection().
    let cancelledOnPauseCount = 0;
    for (const item of this.items.values()) {
      if (item.status !== 'pending') {
        continue;
      }
      item.status = 'cancelled';
      item.error = undefined;
      item.completedAt = DateTime.utc().toISO();
      this.cleanupDedupKey(item);
      this.emitUpdate(item);
      cancelledOnPauseCount++;
    }
    if (cancelledOnPauseCount > 0) {
      log.info(`[BodyFetchQueue] Cancelled ${cancelledOnPauseCount} pending item(s) on pause`);
    }

    await this.disconnectAll();
    log.info('[BodyFetchQueue] Paused — dedicated connections closed, workers will fail fast until resumed');
  }

  /**
   * Resume the body-fetch queue after a pause().
   *
   * Clears the isPaused flag. Connections are recreated lazily on the next
   * worker invocation; no explicit reconnect is needed here.
   *
   * Called by SyncQueueBridge.resume() and SyncQueueBridge.startAfterWake().
   */
  resume(): void {
    this.isPaused = false;
    log.info('[BodyFetchQueue] Resumed — new connections will be created lazily on next enqueue');
  }

  /**
   * Enqueue a body-fetch batch for the given account.
   *
   * If a pending or processing item with the same dedupKey already exists, the
   * enqueue is skipped and the existing queueId is returned (same dedup contract
   * as MailQueueService.enqueue()).
   *
   * @param accountId   Numeric account ID.
   * @param emails      Batch of email descriptors needing body fetch.
   * @param description Human-readable description shown in the queue UI.
   * @param dedupKey    Dedup key — prevents re-enqueueing the same conceptual work.
   * @returns queueId (either new or existing if deduped).
   */
  enqueue(
    accountId: number,
    emails: Array<{ xGmMsgId: string; xGmThrid: string }>,
    description: string,
    dedupKey: string,
  ): string {
    // Deduplication: if a matching item is already active, return its id without re-enqueueing.
    const existingId = this.activeDedupKeys.get(dedupKey);
    if (existingId) {
      const existingItem = this.items.get(existingId);
      if (existingItem && (existingItem.status === 'pending' || existingItem.status === 'processing')) {
        log.debug(`[BodyFetchQueue] Dedup: skipping body-fetch (dedupKey=${dedupKey}) — already queued as ${existingId}`);
        return existingId;
      }
    }

    const queueId = randomUUID();

    const item: QueueItem = {
      queueId,
      accountId,
      type: 'body-fetch',
      payload: { emails },
      status: 'pending',
      createdAt: DateTime.utc().toISO(),
      retryCount: 0,
      description,
      dedupKey,
    };

    this.items.set(queueId, item);
    this.activeDedupKeys.set(dedupKey, queueId);
    this.emitUpdate(item);

    // Push into the account's fastq (created lazily).
    // Lazily create/get the dedicated IMAP connection before the worker runs.
    const workItem: BodyFetchWorkItem = {
      queueId,
      accountId,
      emails,
      description,
    };

    const queue = this.getOrCreateQueue(accountId);
    queue.push(workItem).catch((err) => {
      // fastq rejects only if the worker throws — already handled inside worker
      log.error(`[BodyFetchQueue] Unexpected rejection for ${queueId}:`, err);
    });

    log.info(`[BodyFetchQueue] Enqueued body-fetch (${queueId}) for account ${accountId}: ${description}`);
    return queueId;
  }

  /**
   * Get a snapshot of all body-fetch queue items (for the settings / debug UI).
   */
  getAllItems(): QueueItemSnapshot[] {
    return Array.from(this.items.values()).map((item) => this.snapshot(item));
  }

  /**
   * Get a single item snapshot by queueId.
   */
  getItem(queueId: string): QueueItemSnapshot | null {
    const item = this.items.get(queueId);
    return item ? this.snapshot(item) : null;
  }

  /**
   * Clear completed and cancelled items from the tracking map.
   * Returns the number of items removed.
   */
  clearCompleted(): number {
    let count = 0;
    for (const [id, item] of this.items.entries()) {
      if (item.status === 'completed' || item.status === 'cancelled' || item.status === 'failed') {
        this.items.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Cancel a specific pending (not yet processing) operation.
   * Returns true if the item was found and cancelled, false otherwise.
   */
  cancel(queueId: string): boolean {
    const item = this.items.get(queueId);
    if (!item || item.status !== 'pending') {
      return false;
    }

    item.status = 'cancelled';
    item.error = undefined;
    item.completedAt = DateTime.utc().toISO();
    this.cleanupDedupKey(item);
    this.emitUpdate(item);

    log.info(`[BodyFetchQueue] Cancelled item ${queueId}`);
    return true;
  }

  /**
   * Cancel all pending (not yet processing) items for a given account.
   * Items currently processing are left to complete or fail naturally.
   * Returns the number of items cancelled.
   */
  cancelAllForAccount(accountId: number): number {
    let cancelledCount = 0;
    for (const item of this.items.values()) {
      if (item.accountId !== accountId) {
        continue;
      }
      if (item.status !== 'pending') {
        continue;
      }
      item.status = 'cancelled';
      item.error = undefined;
      item.completedAt = DateTime.utc().toISO();
      this.cleanupDedupKey(item);
      this.emitUpdate(item);
      cancelledCount++;
    }
    if (cancelledCount > 0) {
      log.info(`[BodyFetchQueue] Cancelled ${cancelledCount} pending item(s) for account ${accountId}`);
    }
    return cancelledCount;
  }

  /**
   * Gracefully disconnect and remove the dedicated IMAP connection for a specific account.
   * The connection will be recreated lazily on the next enqueue.
   */
  async disconnectAccount(accountId: number): Promise<void> {
    const client = this.dedicatedConnections.get(accountId);
    if (!client) {
      return;
    }
    this.dedicatedConnections.delete(accountId);
    try {
      await client.logout();
      log.info(`[BodyFetchQueue] Disconnected dedicated connection for account ${accountId}`);
    } catch (err) {
      log.warn(`[BodyFetchQueue] Error disconnecting dedicated connection for account ${accountId}:`, err);
    }
  }

  /**
   * Gracefully disconnect all dedicated IMAP connections (e.g. on app shutdown).
   */
  async disconnectAll(): Promise<void> {
    const accountIds = Array.from(this.dedicatedConnections.keys());
    const disconnectPromises = accountIds.map((accountId) => this.disconnectAccount(accountId));
    await Promise.allSettled(disconnectPromises);
    log.info(`[BodyFetchQueue] Disconnected all dedicated connections (${accountIds.length} account(s))`);
  }

  // -------------------------------------------------------------------------
  // Queue creation & worker
  // -------------------------------------------------------------------------

  private getOrCreateQueue(accountId: number): fastq.queueAsPromised<BodyFetchWorkItem> {
    let queue = this.queues.get(accountId);
    if (!queue) {
      queue = fastq.promise(this.worker.bind(this), 1);
      this.queues.set(accountId, queue);
    }
    return queue;
  }

  /**
   * Ensure a dedicated IMAP connection exists for the given account.
   * Creates one lazily if missing, with 'close' and 'error' handlers that remove
   * the connection from the map (no auto-reconnect — recreated on next enqueue).
   *
   * Throws immediately if the service is paused so in-flight workers fail fast
   * without attempting to open new IMAP sessions while sync is suspended.
   */
  private async ensureDedicatedConnection(accountId: number): Promise<ImapFlow> {
    if (this.isPaused) {
      throw new Error('BodyFetchQueueService is paused');
    }

    const existing = this.dedicatedConnections.get(accountId);
    if (existing && existing.usable) {
      return existing;
    }

    // Remove stale/unusable entry before creating a new one
    if (existing) {
      this.dedicatedConnections.delete(accountId);
    }

    const imapService = ImapService.getInstance();
    const client = await imapService.createDedicatedConnection(String(accountId), 'BODYFETCH');

    // Issue 1 fix: Re-check isPaused after the async connection creation completes.
    // If pause() was called while createDedicatedConnection() was in-flight, we
    // must tear down the freshly-created client immediately rather than register it.
    if (this.isPaused) {
      client.logout().catch(() => {});
      throw new Error('BodyFetchQueueService is paused');
    }

    // Issue 2 fix: Guard close/error handlers with an identity check so that a
    // stale handler from an old client cannot delete a newer connection that was
    // created after a resume() call replaced the map entry.

    // On close: remove from map only if this specific client is still active.
    client.on('close', () => {
      log.info(`[BodyFetchQueue] Dedicated connection closed for account ${accountId}`);
      if (this.dedicatedConnections.get(accountId) === client) {
        this.dedicatedConnections.delete(accountId);
      }
    });

    // On error: remove from map only if this specific client is still active.
    client.on('error', (err: Error) => {
      log.warn(`[BodyFetchQueue] Dedicated connection error for account ${accountId}: ${err.message}`);
      if (this.dedicatedConnections.get(accountId) === client) {
        this.dedicatedConnections.delete(accountId);
      }
    });

    this.dedicatedConnections.set(accountId, client);
    return client;
  }

  /**
   * The fastq worker function — processes one body-fetch work item at a time per account.
   * Failures mark the item as 'failed' immediately (no retry logic).
   */
  private async worker(workItem: BodyFetchWorkItem): Promise<void> {
    const item = this.items.get(workItem.queueId);
    if (!item) {
      log.warn(`[BodyFetchQueue] Worker: item ${workItem.queueId} not found in tracking map, skipping`);
      return;
    }

    // Skip if already cancelled while waiting in queue
    if (item.status === 'cancelled') {
      return;
    }

    // Capture the current test generation at the start of execution.
    // After ensureDedicatedConnection() and fetchAndStoreBodies() we re-check;
    // if the generation changed quiesceAndRestore() ran while we were awaiting
    // and we must abandon the result to avoid corrupting the next suite's DB.
    const capturedGeneration = this.testGeneration;

    item.status = 'processing';
    this.emitUpdate(item);

    try {
      // Ensure a dedicated IMAP connection exists for this account.
      // If connection creation fails, the catch block below marks the item as failed.
      const dedicatedClient = await this.ensureDedicatedConnection(workItem.accountId);

      // Generation check after async connection creation.
      if (this.testGeneration !== capturedGeneration) {
        log.debug(`[BodyFetchQueue] worker: generation changed after connect — abandoning stale body-fetch (${workItem.queueId})`);
        dedicatedClient.logout().catch(() => {});
        return;
      }

      const prefetchService = BodyPrefetchService.getInstance();
      await prefetchService.fetchAndStoreBodies(workItem.accountId, workItem.emails, dedicatedClient);

      // Generation check after the (potentially long) body fetch.
      if (this.testGeneration !== capturedGeneration) {
        log.debug(`[BodyFetchQueue] worker: generation changed after fetch — abandoning stale body-fetch (${workItem.queueId})`);
        return;
      }

      // Schedule incremental vector indexing after bodies are stored.
      // Same pattern as MailQueueService.processBodyFetch().
      // EmbeddingService.incrementalScheduled guard prevents duplicate scheduling.
      try {
        const embeddingService = EmbeddingService.getInstance();
        embeddingService.scheduleIncrementalIndex();
      } catch {
        // EmbeddingService may not be initialized (e.g. sqlite-vec unavailable) — skip silently
      }

      log.debug(
        `[BodyFetchQueue] worker: before item.status=completed queueId=${workItem.queueId} accountId=${workItem.accountId}`,
      );
      item.status = 'completed';
      item.completedAt = DateTime.utc().toISO();
      this.cleanupDedupKey(item);
      log.debug(
        `[BodyFetchQueue] worker: before emitUpdate queueId=${workItem.queueId} accountId=${workItem.accountId} status=${item.status}`,
      );
      this.emitUpdate(item);
      log.debug(
        `[BodyFetchQueue] worker: after emitUpdate queueId=${workItem.queueId} accountId=${workItem.accountId}`,
      );

      log.info(`[BodyFetchQueue] Completed body-fetch (${workItem.queueId}) for account ${workItem.accountId}`);
    } catch (err) {
      // Body-fetch failures are marked immediately with no retry.
      // The next periodic sync cycle will re-enqueue body fetches for any remaining missing bodies.
      const errorMessage = err instanceof Error ? err.message : String(err);

      // Generation check in the failure path: if quiesceAndRestore() ran while this
      // worker was in-flight (e.g. during ensureDedicatedConnection or fetchAndStoreBodies),
      // skip the terminal emitUpdate() so stale 'failed' events cannot repopulate queue
      // state or trigger UI refreshes in the new test suite.
      if (this.testGeneration !== capturedGeneration) {
        log.debug(`[BodyFetchQueue] worker: generation changed in failure path — abandoning stale terminal emit (${workItem.queueId})`);
        // Best-effort teardown of any connection that may have been opened
        const connectionErr = err as Error & { code?: string };
        const errorLower = errorMessage.toLowerCase();
        const isConnectionError =
          errorLower.includes('connection') ||
          errorLower.includes('socket') ||
          errorLower.includes('timeout') ||
          errorLower.includes('econnreset') ||
          errorLower.includes('econnrefused') ||
          connectionErr.code === 'ECONNRESET' ||
          connectionErr.code === 'ECONNREFUSED';
        if (isConnectionError) {
          const staleClient = this.dedicatedConnections.get(workItem.accountId);
          if (staleClient) {
            this.dedicatedConnections.delete(workItem.accountId);
            staleClient.logout().catch(() => {});
          }
        }
        return;
      }

      item.status = 'failed';
      item.error = errorMessage;
      item.completedAt = DateTime.utc().toISO();
      this.cleanupDedupKey(item);
      this.emitUpdate(item);

      // If the connection appears to have been involved in the error, remove it so it
      // gets recreated on the next enqueue (best-effort teardown).
      const connectionErr = err as Error & { code?: string };
      const errorLower = errorMessage.toLowerCase();
      const isConnectionError =
        errorLower.includes('connection') ||
        errorLower.includes('socket') ||
        errorLower.includes('timeout') ||
        errorLower.includes('econnreset') ||
        errorLower.includes('econnrefused') ||
        connectionErr.code === 'ECONNRESET' ||
        connectionErr.code === 'ECONNREFUSED';

      if (isConnectionError) {
        const staleClient = this.dedicatedConnections.get(workItem.accountId);
        if (staleClient) {
          this.dedicatedConnections.delete(workItem.accountId);
          staleClient.logout().catch(() => {});
          log.info(`[BodyFetchQueue] Torn down dedicated connection for account ${workItem.accountId} after connection error`);
        }
      }

      log.warn(`[BodyFetchQueue] Failed body-fetch (${workItem.queueId}) for account ${workItem.accountId}: ${errorMessage}`);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Remove the dedup key for a queue item after its lifecycle ends.
   * Only removes if this item is still the registered owner (prevents races).
   */
  private cleanupDedupKey(item: QueueItem): void {
    if (!item.dedupKey) {
      return;
    }
    if (this.activeDedupKeys.get(item.dedupKey) === item.queueId) {
      this.activeDedupKeys.delete(item.dedupKey);
    }
  }

  /**
   * Send a body-queue:update event with the item snapshot to all renderer windows.
   */
  private emitUpdate(item: QueueItem): void {
    const itemSnapshot = this.snapshot(item);
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.BODY_QUEUE_UPDATE, itemSnapshot);
        }
      }
    } catch (err) {
      log.warn(
        `[BodyFetchQueue] emitUpdate failed queueId=${item.queueId} status=${item.status}:`,
        err,
      );
    }
  }

  /**
   * Build a serialisable snapshot (omitting the payload which may be large).
   */
  private snapshot(item: QueueItem): QueueItemSnapshot {
    const { payload: _payload, ...rest } = item;
    return rest;
  }
}
