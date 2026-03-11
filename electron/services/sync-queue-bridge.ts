import { BrowserWindow } from 'electron';
import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';

const log = LoggerService.getInstance();
import { SyncService, IdleLifecycleToken } from './sync-service';
import { ImapService } from './imap-service';
import { MailQueueService } from './mail-queue-service';
import { BodyFetchQueueService } from './body-fetch-queue-service';

import { IPC_EVENTS } from '../ipc/ipc-channels';

/**
 * SyncQueueBridge — translates sync triggers into deduplicated queue items.
 *
 * Responsibilities:
 * - Owns the background sync timer (moved from SyncService)
 * - On timer tick: fetches mailbox list, upserts labels, enqueues a single
 *   sync-allmail queue item per account (All Mail-based sync)
 * - On IDLE new-mail: enqueues a sync-folder for INBOX (dedup prevents double-queue)
 * - Provides enqueueThreadSync() for MAIL_FETCH_THREAD
 * - Provides enqueueSyncForAccount() for MAIL_SYNC_ACCOUNT
 * - Starts and stops IDLE connections (delegating to SyncService)
 *
 * Dependency order (acyclic):
 *   SyncQueueBridge → MailQueueService → SyncService
 *   SyncQueueBridge → SyncService
 *   (SyncService does NOT import SyncQueueBridge or MailQueueService)
 */
export class SyncQueueBridge {
  private static instance: SyncQueueBridge;

  /** Background sync timer handle. */
  private syncInterval: ReturnType<typeof setInterval> | null = null;

  /** Whether background sync is paused via CLI command. */
  private paused = false;

  /** Whether sync was stopped due to system sleep (cleared on wake; independent of paused). */
  private sleepStopped = false;

  /**
   * Monotonically increasing lifecycle generation counter.
   * Incremented each time start() is called (or resetForTesting() runs).
   * The start() continuation (initial tick → startIdleForAllAccounts()) captures
   * this value at the moment start() begins and re-checks it before opening any IDLE
   * connections. If pause(), stopForSleep(), resetForTesting(), or a subsequent
   * start() executes while the initial tick is in flight, the counter changes and
   * the late continuation is discarded — preventing stale IDLE connections from
   * being opened after a lifecycle state change has torn them down.
   *
   * Also used by startIdleForAllAccounts() to bail early when the instance is in a
   * paused, sleep-stopped, or test-suspended state.
   */
  private startGeneration = 0;

  /**
   * When true, enqueueSyncForAccount() returns immediately without doing any work.
   * Set by suspendForTesting() / cleared by resumeForTesting().
   * Used by quiesceAndRestore() to prevent in-flight background sync calls from
   * the previous test suite from polluting the next suite's queue state.
   *
   * NOT intended for production use.
   */
  private testSuspended = false;

  /**
   * Monotonically increasing generation counter, incremented by suspendForTesting()
   * and resetForTesting().
   * enqueueSyncForAccount() captures this at entry and re-checks it immediately after
   * the only async await (getMailboxesForSync), before any label upsert DB writes.
   * If the counter has changed, the call was made in a previous test suite and must
   * be discarded to prevent stale queue items from polluting the new suite's state.
   *
   * NOT intended for production use.
   */
  private testGeneration = 0;

  private constructor() {}

  static getInstance(): SyncQueueBridge {
    if (!SyncQueueBridge.instance) {
      SyncQueueBridge.instance = new SyncQueueBridge();
    }
    return SyncQueueBridge.instance;
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  /**
   * Start the background sync timer and kick off an initial sync.
   * After the initial sync items are enqueued, starts IDLE for each active account.
   * This replaces SyncService.startBackgroundSync() + the syncAllAccounts() startup call.
   *
   * The start() continuation (initial tick → startIdleForAllAccounts) is lifecycle-fenced:
   * it captures the current startGeneration at entry and will bail before starting IDLE
   * if the generation changes (due to pause/reset/re-start) or if the instance is in a
   * paused, sleep-stopped, or test-suspended state when the tick resolves.
   *
   * @param intervalMs  Override sync interval (ms). Falls back to DB setting or 5 minutes.
   */
  start(intervalMs?: number): void {
    // In test environments, start() is suppressed while testSuspended to prevent
    // background sync ticks from firing when the test harness is resetting state.
    if (this.testSuspended) {
      log.debug('[SyncQueueBridge] start() called but testSuspended — no-op');
      return;
    }

    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    // Capture the lifecycle generation for this particular start() invocation.
    // The continuation below compares against this value before opening IDLE connections.
    this.startGeneration++;
    const capturedStartGeneration = this.startGeneration;

    const db = DatabaseService.getInstance();
    const intervalSetting = db.getSetting('syncInterval');
    const interval = intervalMs || this.parseSyncIntervalMs(intervalSetting);

    this.syncInterval = setInterval(() => {
      this.onSyncTick().catch((err) => {
        log.error('[SyncQueueBridge] Background sync tick failed:', err);
      });
    }, interval);

    log.info(`[SyncQueueBridge] Background sync started with ${interval / 1000}s interval`);

    // Kick off an initial sync tick, then start IDLE after queue items are enqueued.
    // The generation token ensures a late-resolving tick cannot open IDLE connections
    // after a concurrent pause/reset has already torn them down.
    this.onSyncTick()
      .then(() => {
        this.startIdleForAllAccounts(capturedStartGeneration);
      })
      .catch((err) => {
        log.warn('[SyncQueueBridge] Initial sync tick failed:', err);
        // Attempt to start IDLE even when the initial sync failed, but only if the
        // lifecycle state is still consistent with this start() invocation.
        this.startIdleForAllAccounts(capturedStartGeneration);
      });
  }

  /**
   * Stop the background sync timer.
   * Does not stop IDLE connections — call SyncService.stopAllIdle() separately.
   */
  stop(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      log.info('[SyncQueueBridge] Background sync stopped');
    }
  }

  /**
   * Pause background sync and all IMAP IDLE connections.
   * Sets global reconnect suppression FIRST to prevent reconnects during async teardown.
   * Idempotent: calling when already paused is a no-op.
   * Returns a Promise that resolves once the async teardown has completed.
   */
  async pause(): Promise<void> {
    if (this.paused) {
      log.info('[SyncQueueBridge] pause() called but already paused — no-op');
      return;
    }
    this.paused = true;
    this.emitPausedStateChanged(true);
    // Set global IDLE reconnect suppression BEFORE teardown to prevent reconnect
    // timers that fire during async stopAllIdle() from scheduling new connections.
    SyncService.getInstance().setGlobalIdleSuppression(true);
    // Stop the background timer
    this.stop();
    // Increment the lifecycle generation so any in-flight start() continuation
    // (initial tick still resolving) will see the changed token and not reopen IDLE.
    this.startGeneration++;
    // Tear down all IDLE and shared IMAP connections so they are recreated fresh on resume.
    // pause() on BodyFetchQueueService sets the isPaused flag BEFORE disconnecting so that
    // any in-flight fastq workers fail fast instead of lazily opening a new connection.
    try {
      await Promise.all([
        SyncService.getInstance().stopAllIdle(),
        ImapService.getInstance().disconnectAllShared(),
        BodyFetchQueueService.getInstance().pause(),
      ]);
    } catch (err) {
      log.warn('[SyncQueueBridge] pause(): teardown failed:', err);
    }
    log.info('[SyncQueueBridge] Background sync paused');
  }

  /**
   * Resume background sync and restart IMAP IDLE connections.
   * Idempotent: calling when not paused is a no-op.
   */
  resume(): void {
    if (!this.paused) {
      log.info('[SyncQueueBridge] resume() called but not paused — no-op');
      return;
    }
    this.paused = false;
    this.sleepStopped = false; // User resumed; we are no longer in sleep-stopped state
    this.emitPausedStateChanged(false);
    SyncService.getInstance().setGlobalIdleSuppression(false);
    BodyFetchQueueService.getInstance().resume();
    // start() triggers an immediate sync tick and restarts IDLE for all accounts.
    this.start();
    log.info('[SyncQueueBridge] Background sync resumed');
  }

  /**
   * Returns whether background sync is currently paused (user CLI only).
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Returns whether the UI should show the paused indicator (user pause or sleep stopped).
   */
  getPausedForUi(): boolean {
    return this.paused || this.sleepStopped;
  }

  /**
   * Stop sync and IDLE for system sleep. No-op if already user-paused or already sleep-stopped.
   * Does not set paused or emit paused state to renderer.
   */
  stopForSleep(): void {
    if (this.paused) {
      return;
    }
    if (this.sleepStopped) {
      return;
    }
    SyncService.getInstance().setGlobalIdleSuppression(true);
    this.stop();
    // Increment the lifecycle generation so any in-flight start() continuation
    // will see the changed token and not reopen IDLE after sleep teardown.
    this.startGeneration++;
    // Close shared IMAP connections so they are recreated fresh on wake.
    // Stale TCP sockets after sleep may report usable=true but hang on any command.
    // pause() on BodyFetchQueueService sets the isPaused flag BEFORE disconnecting so that
    // any in-flight fastq workers fail fast instead of lazily opening a new connection.
    Promise.all([
      SyncService.getInstance().stopAllIdle(),
      ImapService.getInstance().disconnectAllShared(),
      BodyFetchQueueService.getInstance().pause(),
    ]).catch((err) => {
      log.warn('[SyncQueueBridge] stopForSleep(): teardown failed:', err);
    });
    this.sleepStopped = true;
    this.emitPausedStateChanged(this.getPausedForUi());
    log.info('[SyncQueueBridge] Sync stopped for system sleep');
  }

  /**
   * Resume sync after wake. No-op if not sleep-stopped or if user is still paused.
   */
  startAfterWake(): void {
    if (!this.sleepStopped) {
      return;
    }
    this.sleepStopped = false;
    this.emitPausedStateChanged(this.getPausedForUi());
    if (this.paused) {
      return;
    }
    SyncService.getInstance().setGlobalIdleSuppression(false);
    BodyFetchQueueService.getInstance().resume();
    this.start();
    log.info('[SyncQueueBridge] Sync started after wake');
  }

  // -----------------------------------------------------------------------
  // Account-level sync
  // -----------------------------------------------------------------------

  /**
   * Enqueue a single sync-allmail item for an account.
   * Fetches the mailbox list and upserts labels (needed for label-to-folder validation),
   * then enqueues a single sync-allmail queue item with a dedup key.
   *
   * @param accountId  Numeric account ID.
   * @param showNotifications  Unused (kept for interface compatibility). Notifications
   *                           are handled by the IDLE INBOX sync path only.
   */
  async enqueueSyncForAccount(accountId: number, _showNotifications = false): Promise<string | null> {
    // In test environments, quiesceAndRestore() sets testSuspended=true to prevent
    // in-flight background sync ticks from the previous suite from polluting the
    // new suite's queue. Return immediately if suspended.
    if (this.testSuspended) {
      log.debug(`[SyncQueueBridge] enqueueSyncForAccount: testSuspended — skipping account ${accountId}`);
      return null;
    }

    // Capture the generation counter BEFORE any async work so we can detect if
    // quiesceAndRestore() ran (and incremented the counter) while we were awaiting.
    // This prevents a stale in-flight call from the previous suite from enqueuing
    // a sync item after the new suite has been set up (dedup-key collision / wrong data).
    const capturedGeneration = this.testGeneration;

    const syncService = SyncService.getInstance();
    const queue = MailQueueService.getInstance();
    const db = DatabaseService.getInstance();

    const accountIdStr = String(accountId);

    // Emit syncing progress to keep the status bar "Last synced" indicator updated.
    this.emitProgress(accountIdStr, 0, 'syncing');

    let mailboxes: Awaited<ReturnType<typeof syncService.getMailboxesForSync>>;
    try {
      mailboxes = await syncService.getMailboxesForSync(accountIdStr);
    } catch (err) {
      log.error(`[SyncQueueBridge] Failed to fetch mailboxes for account ${accountId}:`, err);
      this.emitProgress(accountIdStr, 0, 'error', err instanceof Error ? err.message : 'Failed to fetch mailboxes');
      return null;
    }

    // Re-check for test isolation immediately after the only async boundary
    // (getMailboxesForSync), before any DB writes (label upsert, sync state, enqueue).
    // If quiesceAndRestore() called suspendForTesting() while we were awaiting the IMAP
    // LIST response, testGeneration will have been incremented. Bail out here to avoid
    // writing stale labels or enqueuing an item that would pollute the new test suite's
    // queue state (dedup-key collision or sync running against the wrong account/message
    // state).
    // NOTE: we check the generation rather than testSuspended because seedTestAccount()
    // re-lifts testSuspended before the new suite starts — but the generation counter
    // only increments on suspend, so it unambiguously identifies a suite boundary.
    if (this.testGeneration !== capturedGeneration) {
      log.debug(`[SyncQueueBridge] enqueueSyncForAccount: generation changed (${capturedGeneration} → ${this.testGeneration}) — aborting stale enqueue for account ${accountId}`);
      return null;
    }

    // Upsert labels from the fresh mailbox list (needed for label-to-folder validation).
    // This write is intentionally placed AFTER the generation re-check so that a stale
    // in-flight call does not overwrite labels belonging to the new test suite's account.
    syncService.upsertLabelsFromMailboxes(accountId, mailboxes);

    // Determine sync scope.
    const syncState = db.getAccountSyncState(accountId);
    const isInitial = !syncState.lastSyncAt;
    const sinceDate = isInitial
      ? DateTime.utc().minus({ days: 30 }).toJSDate() // Last 30 days for initial sync
      : DateTime.fromISO(syncState.lastSyncAt!).toJSDate();

    log.info(`[SyncQueueBridge] enqueueSyncForAccount: account=${accountId}, isInitial=${isInitial}, sinceDate=${sinceDate.toISOString()}`);

    // Enqueue a single sync-allmail item with a dedup key.
    // Returns the queueId so callers can track this exact sync item via queue:update events.
    const dedupKey = `sync-allmail:${accountId}`;
    const queueId = queue.enqueue(
      accountId,
      'sync-allmail',
      {
        isInitial,
        sinceDate: sinceDate.toISOString(),
      },
      `Sync All Mail`,
      undefined,
      dedupKey,
    );

    // Update account sync state timestamp now (reflects when we last triggered a sync).
    db.updateAccountSyncState(accountId, DateTime.utc().toISO());

    // Emit done to update the "Last synced" indicator in the status bar.
    this.emitProgress(accountIdStr, 100, 'done');

    log.info(`[SyncQueueBridge] enqueueSyncForAccount: enqueued sync-allmail for account ${accountId} (queueId=${queueId})`);
    return queueId;
  }

  // -----------------------------------------------------------------------
  // IDLE → queue bridging
  // -----------------------------------------------------------------------

  /**
   * Enqueue a sync-folder item for INBOX (called from IDLE onNewMail callback).
   * Uses a dedup key so rapid IDLE signals don't stack up duplicate items.
   * Sets showNotifications=true so new emails trigger a desktop notification.
   *
   * @param accountId  Account ID as string (matching the IDLE connection's accountId format).
   */
  enqueueInboxSync(accountId: string): void {
    if (this.paused) {
      log.debug('[SyncQueueBridge] enqueueInboxSync: skipped — sync is paused');
      return;
    }
    const numAccountId = Number(accountId);
    const queue = MailQueueService.getInstance();
    const db = DatabaseService.getInstance();

    const syncState = db.getAccountSyncState(numAccountId);
    const isInitial = !syncState.lastSyncAt;
    const sinceDate = isInitial
      ? DateTime.utc().minus({ days: 30 }).toJSDate()
      : DateTime.fromISO(syncState.lastSyncAt!).toJSDate();

    const dedupKey = `sync-folder:${numAccountId}:INBOX`;
    queue.enqueue(
      numAccountId,
      'sync-folder',
      {
        folder: 'INBOX',
        isInitial,
        sinceDate: sinceDate.toISOString(),
        showNotifications: true, // IDLE-triggered syncs show desktop notifications
      },
      'Sync INBOX',
      undefined,
      dedupKey,
    );

    log.debug(`[SyncQueueBridge] enqueueInboxSync: enqueued sync-folder for INBOX (account ${accountId})`);
  }

  /**
   * Enqueue a sync-allmail item triggered by an All Mail IDLE expunge event.
   * Uses the same dedup key as the periodic timer sync (`sync-allmail:${accountId}`)
   * to prevent redundant concurrent syncs from both the timer and IDLE events.
   *
   * @param accountId  Account ID as string.
   */
  enqueueAllMailSync(accountId: string): void {
    if (this.paused) {
      log.debug('[SyncQueueBridge] enqueueAllMailSync: skipped — sync is paused');
      return;
    }
    const numAccountId = Number(accountId);
    const queue = MailQueueService.getInstance();
    const db = DatabaseService.getInstance();

    const syncState = db.getAccountSyncState(numAccountId);
    const isInitial = !syncState.lastSyncAt;
    const sinceDate = isInitial
      ? DateTime.utc().minus({ days: 30 }).toJSDate()
      : DateTime.fromISO(syncState.lastSyncAt!).toJSDate();

    // Use the same dedup key as the periodic timer sync to prevent pile-up
    const dedupKey = `sync-allmail:${numAccountId}`;
    queue.enqueue(
      numAccountId,
      'sync-allmail',
      {
        isInitial,
        sinceDate: sinceDate.toISOString(),
      },
      'Sync All Mail',
      undefined,
      dedupKey,
    );

    log.debug(`[SyncQueueBridge] enqueueAllMailSync: enqueued sync-allmail for account ${accountId} (IDLE expunge-triggered)`);
  }

  // -----------------------------------------------------------------------
  // Thread sync
  // -----------------------------------------------------------------------

  /**
   * Enqueue a sync-thread item to fetch and reconcile a thread's bodies from IMAP.
   * Uses a dedup key so clicking the same thread multiple times only results in one fetch.
   * Called by the MAIL_FETCH_THREAD IPC handler when bodies are missing.
   *
   * @param accountId       Numeric account ID.
   * @param xGmThrid        Gmail thread ID to fetch.
   * @param forceFromServer Whether to bypass the body-exists check.
   * @returns The queueId for the enqueued item.
   */
  enqueueThreadSync(accountId: number, xGmThrid: string, forceFromServer = false): string {
    const queue = MailQueueService.getInstance();
    const dedupKey = `sync-thread:${accountId}:${xGmThrid}`;
    return queue.enqueue(
      accountId,
      'sync-thread',
      { xGmThrid, forceFromServer },
      `Fetch thread bodies`,
      undefined,
      dedupKey,
    );
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  /**
   * Called on each background sync timer tick.
   * Enqueues metadata sync items for all active (non-reauth-needed) accounts.
   * Body-prefetch is enqueued by MailQueueService after each sync-allmail item
   * finishes processing, so it runs against freshly-synced email rows.
   */
  private async onSyncTick(): Promise<void> {
    const db = DatabaseService.getInstance();
    const accounts = db.getAccounts();

    const promises = accounts
      .filter((a) => !a.needsReauth)
      .map((a) =>
        this.enqueueSyncForAccount(a.id, false).catch((err) => {
          log.error(`[SyncQueueBridge] onSyncTick: failed to enqueue sync for account ${a.id}:`, err);
        })
      );

    await Promise.allSettled(promises);
  }

  /**
   * Start IDLE connections for all active accounts.
   * Called after the initial sync tick so IDLE connections benefit from the initial sync state.
   * Starts both INBOX IDLE (for new mail detection) and All Mail IDLE (for expunge detection).
   *
   * Guarded by a lifecycle token: if the capturedGeneration no longer matches the current
   * startGeneration (because pause(), stopForSleep(), or resetForTesting() ran while the
   * initial tick was in flight), or if the instance is currently paused, sleep-stopped, or
   * test-suspended, this method returns immediately without opening any connections.
   *
   * A per-call IdleLifecycleToken is passed into each startIdle / startIdleAllMail call so
   * that even if the IMAP connect itself is in flight when a lifecycle change arrives, the
   * newly-opened connection is torn down before it is left alive.
   *
   * @param capturedGeneration  The startGeneration value captured at the start of the
   *                            start() invocation that scheduled this call.
   */
  private startIdleForAllAccounts(capturedGeneration: number): void {
    // Bail if the lifecycle has advanced since this start() invocation began.
    // This prevents a late-resolving initial tick from reopening IDLE after a
    // concurrent pause/sleep-stop/reset has already torn down the connections.
    if (this.startGeneration !== capturedGeneration) {
      log.debug(
        `[SyncQueueBridge] startIdleForAllAccounts: lifecycle generation changed ` +
        `(${capturedGeneration} → ${this.startGeneration}) — skipping IDLE start`,
      );
      return;
    }

    // Bail if the instance is in any stopped/suspended state at the moment the tick resolves.
    if (this.paused || this.sleepStopped || this.testSuspended) {
      log.debug(
        `[SyncQueueBridge] startIdleForAllAccounts: instance is paused/sleepStopped/testSuspended — skipping IDLE start`,
      );
      return;
    }

    const db = DatabaseService.getInstance();
    const syncService = SyncService.getInstance();
    const accounts = db.getAccounts();

    for (const account of accounts) {
      if (!account.needsReauth) {
        const accountId = String(account.id);
        this.startIdleForAccountInternal(accountId, syncService, capturedGeneration);
      }
    }
  }

  /**
   * Start IDLE connections for a single account, with full lifecycle fencing.
   *
   * Used by the auth login path (enqueueSyncForAccount → startIdleForAccount) to start IDLE
   * for a newly-added account without bypassing the lifecycle guards. The same generation
   * token and suppression checks that protect startIdleForAllAccounts are applied here.
   *
   * Guarded identically to startIdleForAllAccounts: if the bridge is paused, sleep-stopped,
   * or test-suspended at call time, this method is a no-op. A per-call IdleLifecycleToken is
   * passed into startIdle / startIdleAllMail so that an in-flight IMAP connect is torn down if
   * the lifecycle changes while it is awaiting.
   *
   * @param accountId  Account ID as string.
   */
  startIdleForAccount(accountId: string): void {
    if (this.paused || this.sleepStopped || this.testSuspended) {
      log.debug(
        `[SyncQueueBridge] startIdleForAccount: skipping IDLE start for account ${accountId} ` +
        `— bridge is paused/sleepStopped/testSuspended`,
      );
      return;
    }

    const syncService = SyncService.getInstance();
    this.startIdleForAccountInternal(accountId, syncService, this.startGeneration);
  }

  /**
   * Internal helper — starts INBOX and All Mail IDLE for one account with a lifecycle token.
   * Callers are responsible for the pre-call lifecycle guard checks.
   *
   * @param accountId          Account ID as string.
   * @param syncService        SyncService singleton (caller resolves to avoid repeated lookups).
   * @param capturedGeneration The startGeneration value to embed in the lifecycle token.
   */
  private startIdleForAccountInternal(
    accountId: string,
    syncService: SyncService,
    capturedGeneration: number,
  ): void {
    // Build a lifecycle token whose isValid() check covers both the generation counter and the
    // global IDLE suppression flag. startIdle / startIdleAllMail call this after their async
    // IMAP connect completes to detect whether the lifecycle changed mid-flight.
    const lifecycleToken: IdleLifecycleToken = {
      isValid: () =>
        this.startGeneration === capturedGeneration &&
        !this.paused &&
        !this.sleepStopped &&
        !this.testSuspended,
    };

    // Start INBOX IDLE — handles new mail with low latency
    syncService
      .startIdle(
        accountId,
        () => {
          this.enqueueInboxSync(accountId);
        },
        lifecycleToken,
      )
      .catch((err) => {
        log.warn(`[SyncQueueBridge] Failed to start INBOX IDLE for account ${accountId}:`, err);
      });

    // Start All Mail IDLE — handles server-side deletion detection via expunge events
    syncService
      .startIdleAllMail(
        accountId,
        (idleAccountId) => {
          this.enqueueAllMailSync(idleAccountId);
        },
        lifecycleToken,
      )
      .catch((err) => {
        log.warn(`[SyncQueueBridge] Failed to start All Mail IDLE for account ${accountId}:`, err);
      });
  }

  /**
   * Parse the sync interval setting (supports both legacy "minutes" and new "ms" formats).
   * Returns milliseconds. Minimum 60 seconds.
   */
  private parseSyncIntervalMs(value: string | null): number {
    if (!value) {
      return 300_000;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return 300_000;
    }
    // Backward compatibility: older values were stored as minutes.
    if (parsed < 1000) {
      return Math.max(60_000, parsed * 60_000);
    }
    return Math.max(60_000, parsed);
  }

  /**
   * Emit SYNC_PAUSED_STATE_CHANGED event to all renderer windows.
   * Called immediately after the paused flag changes so the UI indicator updates instantly.
   */
  private emitPausedStateChanged(paused: boolean): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.SYNC_PAUSED_STATE_CHANGED, { paused });
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }

  /**
   * Emit MAIL_SYNC progress event to all renderer windows.
   * Used to update the "Last synced" indicator and syncing spinner in the status bar.
   */
  private emitProgress(
    accountId: string,
    progress: number,
    status: 'syncing' | 'done' | 'error',
    error?: string,
  ): void {
    const payload = { accountId, folder: '', progress, newCount: 0, status, error };
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.MAIL_SYNC, payload);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }

  /**
   * Hard-reset SyncQueueBridge for inter-suite test isolation.
   *
   * Performs a full synchronous teardown:
   *   1. Increments the test generation counter so any in-flight enqueueSyncForAccount()
   *      call detects the suite boundary and aborts after its next await.
   *   2. Increments the start generation counter so any in-flight start() continuation
   *      (initial tick still resolving) detects the reset and does not reopen IDLE.
   *   3. Sets testSuspended=true so new calls return immediately without work.
   *   4. Clears the background sync interval so no further ticks fire between
   *      quiesce and the start of the new suite. Without this step a stale
   *      setInterval created by a previous suite's resume()/start() call can
   *      revive and call onSyncTick() while the DB is being restored, causing
   *      spurious IMAP connections and queue writes against the wrong state.
   *   5. Resets paused/sleepStopped flags so the next suite always starts clean.
   *
   * resumeForTesting() must be called (via seedTestAccount()) to lift the
   * suspension and allow the new suite to start fresh.
   *
   * NOT intended for production use.
   */
  resetForTesting(): void {
    // Step 1: increment test generation FIRST so in-flight enqueueSyncForAccount()
    // awaits detect the suite boundary.
    this.testGeneration++;

    // Step 2: increment start generation so in-flight start() continuations
    // (initial tick → startIdleForAllAccounts) bail before opening IDLE connections.
    this.startGeneration++;

    // Step 3: suspend so new entry-point calls return immediately.
    this.testSuspended = true;

    // Step 4: clear the background sync timer.
    // Without this a stale setInterval from a previous suite's start()/resume()
    // continues to fire onSyncTick() even after quiesceAndRestore() clears the
    // queue, potentially calling enqueueSyncForAccount() (and from there
    // getMailboxesForSync / DB writes) against the restored DB with the wrong
    // account/credential state.
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    // Step 5: reset runtime flags so the new suite starts from a known clean state.
    this.paused = false;
    this.sleepStopped = false;

    log.debug(`[SyncQueueBridge] resetForTesting: timer cleared, suspended (testGeneration=${this.testGeneration}, startGeneration=${this.startGeneration})`);
  }

  /**
   * Suspend enqueueSyncForAccount() for test isolation.
   *
   * After this call, any concurrent or future `enqueueSyncForAccount()` calls
   * return immediately without doing any IMAP or queue work. This prevents
   * background sync ticks triggered by a previous test suite's `resume()` call
   * from polluting the new suite's queue state.
   *
   * Call `resumeForTesting()` once the new suite is fully set up and ready to sync.
   *
   * Prefer resetForTesting() over suspendForTesting() for quiesceAndRestore()
   * because resetForTesting() also clears the background timer and increments the
   * start generation — suspendForTesting() only blocks new entry-point calls and
   * leaves the interval running.
   *
   * NOT intended for production use.
   */
  suspendForTesting(): void {
    this.testSuspended = true;
    this.testGeneration++;
    log.debug(`[SyncQueueBridge] Suspended for testing (generation ${this.testGeneration})`);
  }

  /**
   * Lift the test suspension so enqueueSyncForAccount() works normally again.
   * Must be called after quiesceAndRestore() completes and before the first
   * callIpc('mail:sync-account') in the new test suite.
   *
   * NOT intended for production use.
   */
  resumeForTesting(): void {
    this.testSuspended = false;
    log.debug('[SyncQueueBridge] Resumed for testing');
  }
}
