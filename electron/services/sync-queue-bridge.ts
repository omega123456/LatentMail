import { BrowserWindow } from 'electron';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';

const log = LoggerService.getInstance();
import { SyncService } from './sync-service';
import { MailQueueService } from './mail-queue-service';
import { BodyPrefetchService } from './body-prefetch-service';
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

  /** Body-prefetch timer handle (interval, offset by half the sync interval). */
  private bodyPrefetchInterval: ReturnType<typeof setInterval> | null = null;

  /** Timeout used to delay the start of the body-prefetch interval (offset timer). */
  private bodyPrefetchOffsetTimeout: ReturnType<typeof setTimeout> | null = null;

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

    // Start body-prefetch timer offset by half the sync interval so it fires at the
    // midpoint between metadata sync ticks, reducing IMAP connection contention.
    this.bodyPrefetchOffsetTimeout = setTimeout(() => {
      this.bodyPrefetchOffsetTimeout = null;
      this.onBodyPrefetchTick().catch((err) => {
        log.error('[SyncQueueBridge] Body-prefetch tick (initial) failed:', err);
      });
      this.bodyPrefetchInterval = setInterval(() => {
        this.onBodyPrefetchTick().catch((err) => {
          log.error('[SyncQueueBridge] Body-prefetch tick failed:', err);
        });
      }, interval);
    }, interval / 2);

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
    if (this.bodyPrefetchOffsetTimeout) {
      clearTimeout(this.bodyPrefetchOffsetTimeout);
      this.bodyPrefetchOffsetTimeout = null;
    }
    if (this.bodyPrefetchInterval) {
      clearInterval(this.bodyPrefetchInterval);
      this.bodyPrefetchInterval = null;
      log.info('[SyncQueueBridge] Body-prefetch timer stopped');
    }
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
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days for initial sync
      : new Date(syncState.lastSyncAt!);

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
    db.updateAccountSyncState(accountId, new Date().toISOString());

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
    const numAccountId = Number(accountId);
    const queue = MailQueueService.getInstance();
    const db = DatabaseService.getInstance();

    const syncState = db.getAccountSyncState(numAccountId);
    const isInitial = !syncState.lastSyncAt;
    const sinceDate = isInitial
      ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      : new Date(syncState.lastSyncAt!);

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
   * Called on each body-prefetch timer tick (offset by half the sync interval).
   * Queries the DB for emails with missing bodies and enqueues body-fetch items
   * per account. Uses dedup key `body-fetch:{accountId}` to prevent duplicates.
   */
  private async onBodyPrefetchTick(): Promise<void> {
    const db = DatabaseService.getInstance();
    const queue = MailQueueService.getInstance();
    const prefetchService = BodyPrefetchService.getInstance();
    const accounts = db.getAccounts();

    for (const account of accounts) {
      if (account.needs_reauth) {
        continue;
      }
      try {
        const emails = prefetchService.getEmailsNeedingBodies(account.id, 50);
        if (emails.length === 0) {
          continue;
        }
        const dedupKey = `body-fetch:${account.id}`;
        queue.enqueue(
          account.id,
          'body-fetch',
          { emails: emails.map((email) => ({ xGmMsgId: email.xGmMsgId, xGmThrid: email.xGmThrid })) },
          `Prefetch ${emails.length} email bodies`,
          undefined,
          dedupKey,
        );
        log.debug(`[SyncQueueBridge] onBodyPrefetchTick: enqueued body-fetch for account ${account.id} (${emails.length} emails)`);
      } catch (err) {
        log.warn(`[SyncQueueBridge] onBodyPrefetchTick: failed for account ${account.id}:`, err);
      }
    }
  }

  /**
   * Called on each background sync timer tick.
   * Enqueues per-folder sync items for all active (non-reauth-needed) accounts.
   */
  private async onSyncTick(): Promise<void> {
    const db = DatabaseService.getInstance();
    const accounts = db.getAccounts();

    const promises = accounts
      .filter((a) => !a.needs_reauth)
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
   */
  private startIdleForAllAccounts(): void {
    const db = DatabaseService.getInstance();
    const syncService = SyncService.getInstance();
    const accounts = db.getAccounts();

    for (const account of accounts) {
      if (!account.needs_reauth) {
        syncService
          .startIdle(String(account.id), () => {
            this.enqueueInboxSync(String(account.id));
          })
          .catch((err) => {
            log.warn(`[SyncQueueBridge] Failed to start IDLE for account ${account.id}:`, err);
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
