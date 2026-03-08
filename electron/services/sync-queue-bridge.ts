import { BrowserWindow } from 'electron';
import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';

const log = LoggerService.getInstance();
import { SyncService } from './sync-service';
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
   * @param intervalMs  Override sync interval (ms). Falls back to DB setting or 5 minutes.
   */
  start(intervalMs?: number): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

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
    this.onSyncTick()
      .then(() => {
        this.startIdleForAllAccounts();
      })
      .catch((err) => {
        log.warn('[SyncQueueBridge] Initial sync tick failed:', err);
        // Still start IDLE even if the initial sync failed
        this.startIdleForAllAccounts();
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
   */
  pause(): void {
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
    // Tear down all IDLE and shared IMAP connections so they are recreated fresh on resume.
    // pause() on BodyFetchQueueService sets the isPaused flag BEFORE disconnecting so that
    // any in-flight fastq workers fail fast instead of lazily opening a new connection.
    Promise.all([
      SyncService.getInstance().stopAllIdle(),
      ImapService.getInstance().disconnectAllShared(),
      BodyFetchQueueService.getInstance().pause(),
    ]).catch((err) => {
      log.warn('[SyncQueueBridge] pause(): teardown failed:', err);
    });
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
  async enqueueSyncForAccount(accountId: number, _showNotifications = false): Promise<void> {
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
      return;
    }

    // Upsert labels from the fresh mailbox list (needed for label-to-folder validation).
    syncService.upsertLabelsFromMailboxes(accountId, mailboxes);

    // Determine sync scope.
    const syncState = db.getAccountSyncState(accountId);
    const isInitial = !syncState.lastSyncAt;
    const sinceDate = isInitial
      ? DateTime.utc().minus({ days: 30 }).toJSDate() // Last 30 days for initial sync
      : DateTime.fromISO(syncState.lastSyncAt!).toJSDate();

    log.info(`[SyncQueueBridge] enqueueSyncForAccount: account=${accountId}, isInitial=${isInitial}, sinceDate=${sinceDate.toISOString()}`);

    // Enqueue a single sync-allmail item with a dedup key.
    const dedupKey = `sync-allmail:${accountId}`;
    queue.enqueue(
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

    log.info(`[SyncQueueBridge] enqueueSyncForAccount: enqueued sync-allmail for account ${accountId}`);
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
   */
  private startIdleForAllAccounts(): void {
    const db = DatabaseService.getInstance();
    const syncService = SyncService.getInstance();
    const accounts = db.getAccounts();

    for (const account of accounts) {
      if (!account.needsReauth) {
        const accountId = String(account.id);

        // Start INBOX IDLE — handles new mail with low latency
        syncService
          .startIdle(accountId, () => {
            this.enqueueInboxSync(accountId);
          })
          .catch((err) => {
            log.warn(`[SyncQueueBridge] Failed to start INBOX IDLE for account ${account.id}:`, err);
          });

        // Start All Mail IDLE — handles server-side deletion detection via expunge events
        syncService
          .startIdleAllMail(accountId, (id) => {
            this.enqueueAllMailSync(id);
          })
          .catch((err) => {
            log.warn(`[SyncQueueBridge] Failed to start All Mail IDLE for account ${account.id}:`, err);
          });
      }
    }
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
}
