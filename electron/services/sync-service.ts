import { BrowserWindow, Notification } from 'electron';
import log from 'electron-log/main';
import { ImapService } from './imap-service';
import { DatabaseService } from './database-service';
import { FolderLockManager } from './folder-lock-manager';
import { OAuthService } from './oauth-service';
import { FilterService } from './filter-service';
import { PendingOpService } from './pending-op-service';
import { IPC_EVENTS } from '../ipc/ipc-channels';

/** Gmail special-use folder mappings (All Mail excluded — not shown or synced) */
const GMAIL_FOLDER_MAP: Record<string, { name: string; icon: string }> = {
  '\\Inbox': { name: 'Inbox', icon: 'inbox' },
  '\\Drafts': { name: 'Drafts', icon: 'edit_note' },
  '\\Sent': { name: 'Sent', icon: 'send' },
  '\\Trash': { name: 'Trash', icon: 'delete' },
  '\\Junk': { name: 'Spam', icon: 'report' },
  '\\Flagged': { name: 'Starred', icon: 'star' },
  '\\Important': { name: 'Important', icon: 'label_important' },
};

/** Priority folders to sync first */
const PRIORITY_FOLDERS = ['INBOX', '[Gmail]/Sent Mail', '[Gmail]/Drafts'];

interface SyncProgress {
  accountId: string;
  folder: string;
  progress: number;    // 0-100
  newCount: number;
  status: 'syncing' | 'done' | 'error';
  error?: string;
}

interface NewEmailInfo {
  gmailMessageId: string;
  gmailThreadId: string;
  sender: string;
  subject: string;
  snippet: string;
}

interface NotificationBatch {
  timer: ReturnType<typeof setTimeout>;
  emails: NewEmailInfo[];
}

export class SyncService {
  private static instance: SyncService;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private syncInProgress: Set<string> = new Set();
  private idleAccounts: Set<string> = new Set();
  /** Per-account notification batching accumulators */
  private notificationBatches: Map<string, NotificationBatch> = new Map();
  /** IDLE reconnection backoff timers (per account) */
  private idleReconnectTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  /** Current reconnection backoff delay per account (ms) */
  private idleReconnectDelay: Map<string, number> = new Map();
  /** Accounts where IDLE stop/reconnect was intentional — suppress auto-reconnect */
  private idleSuppressReconnect: Set<string> = new Set();
  /**
   * Timestamps of the last reconciliation run per "accountId:folder" key.
   * Used for debouncing IDLE-triggered reconciliation (30-second minimum interval).
   */
  private lastReconciliation: Map<string, number> = new Map();

  private constructor() {}

  static getInstance(): SyncService {
    if (!SyncService.instance) {
      SyncService.instance = new SyncService();
    }
    return SyncService.instance;
  }

  /**
   * Sync a single account — fetches folders, then emails from each folder.
   */
  async syncAccount(accountId: string): Promise<void> {
    if (this.syncInProgress.has(accountId)) {
      log.info(`Sync already in progress for account ${accountId}, skipping`);
      return;
    }

    this.syncInProgress.add(accountId);
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();

    try {
      log.info(`Starting sync for account ${accountId}`);
      this.emitProgress({ accountId, folder: '', progress: 0, newCount: 0, status: 'syncing' });

      // 1. Fetch and store folder list
      const mailboxes = await imapService.getMailboxes(accountId);
      const numAccountId = Number(accountId);

      for (const mb of mailboxes) {
        if (mb.path === '[Gmail]/All Mail') {
          continue; // All Mail not stored or synced
        }
        const specialUseInfo = GMAIL_FOLDER_MAP[mb.specialUse];
        db.upsertLabel({
          accountId: numAccountId,
          gmailLabelId: mb.path,
          name: specialUseInfo?.name || mb.name,
          type: mb.specialUse ? 'system' : 'user',
          unreadCount: mb.unseen,
          totalCount: mb.messages,
        });
      }

      // 2. Determine sync scope
      const syncState = db.getAccountSyncState(numAccountId);
      const isInitialSync = !syncState.lastSyncAt;
      const sinceDate = isInitialSync
        ? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) // Last 30 days
        : new Date(syncState.lastSyncAt!);

      log.info(`Sync scope: isInitialSync=${isInitialSync}, sinceDate=${sinceDate.toISOString()}, lastSyncAt=${syncState.lastSyncAt}`);

      // 3. Sync priority folders first, then others (exclude All Mail)
      const ALL_MAIL_PATH = '[Gmail]/All Mail';
      const allFolders = mailboxes
        .filter(mb => mb.listed && mb.messages > 0 && mb.path !== ALL_MAIL_PATH)
        .map(mb => mb.path);

      const priorityFolders = PRIORITY_FOLDERS.filter(f => allFolders.includes(f));
      const otherFolders = allFolders.filter(f => !PRIORITY_FOLDERS.includes(f));
      const foldersToSync = [...priorityFolders, ...otherFolders];

      let folderIndex = 0;
      let totalNewCount = 0;

      for (const folder of foldersToSync) {
        folderIndex++;
        const progress = Math.round((folderIndex / foldersToSync.length) * 100);
        this.emitProgress({ accountId, folder, progress, newCount: totalNewCount, status: 'syncing' });

        // Acquire folder lock to coordinate with queue operations
        const lockManager = FolderLockManager.getInstance();
        let releaseLock: (() => void) | null = null;
        try {
          releaseLock = await lockManager.acquire(folder);
        } catch (lockErr) {
          log.warn(`Sync: failed to acquire lock on ${folder} (skipping):`, lockErr);
          continue;
        }

        // Pre-declare outside try/finally so reconciliation below can access it.
        let serverUidsForReconcile: number[] = [];

        try {
          const fetchLimit = isInitialSync ? 100 : 200;
          // Fetch server UIDs for reconciliation while we already hold the folder lock.
          // We capture them here and use them below (after lock release) to avoid deadlock.
          try {
            serverUidsForReconcile = await imapService.fetchFolderUids(accountId, folder);
          } catch (uidErr) {
            log.warn(`Sync: failed to fetch UIDs for ${folder} (reconciliation will be skipped):`, uidErr);
          }

          const emails = await imapService.fetchEmails(accountId, folder, {
            limit: fetchLimit,
            since: sinceDate,
          });

          // Group emails by thread, excluding those with pending queue operations.
          // Pending emails are skipped entirely — re-upserting them would undo the
          // optimistic folder association update made by the IPC handler.
          const pendingOpService = PendingOpService.getInstance();
          const threadMap = new Map<string, typeof emails>();
          for (const email of emails) {
            const threadId = email.gmailThreadId || email.gmailMessageId;
            const pendingForThread = pendingOpService.getPendingForThread(numAccountId, threadId);
            if (pendingForThread.has(email.gmailMessageId)) {
              log.debug(`Sync: skipping pending message ${email.gmailMessageId} in ${folder}`);
              continue; // Skip pending emails entirely
            }
            if (!threadMap.has(threadId)) {
              threadMap.set(threadId, []);
            }
            threadMap.get(threadId)!.push(email);
          }

          // Store emails and build threads (pending emails already excluded from threadMap above).
          for (const email of [...threadMap.values()].flat()) {

            db.upsertEmail({
              accountId: numAccountId,
              gmailMessageId: email.gmailMessageId,
              gmailThreadId: email.gmailThreadId,
              folder,
              folderUid: email.uid,
              fromAddress: email.fromAddress,
              fromName: email.fromName,
              toAddresses: email.toAddresses,
              ccAddresses: email.ccAddresses,
              bccAddresses: email.bccAddresses,
              subject: email.subject,
              textBody: email.textBody,
              htmlBody: email.htmlBody,
              date: email.date,
              isRead: email.isRead,
              isStarred: email.isStarred,
              isImportant: email.isImportant,
              isDraft: email.isDraft,
              snippet: email.snippet,
              size: email.size,
              hasAttachments: email.hasAttachments,
              labels: email.labels,
            });

            // Update contacts
            if (email.fromAddress) {
              db.upsertContact(email.fromAddress, email.fromName);
            }
          }

          // Upsert threads (dedupe emails by gmailMessageId so the same message
          // appearing in multiple folders doesn't inflate counts or create duplicates)
          for (const [threadId, threadEmails] of threadMap) {
            // Dedupe by gmailMessageId — same message in two folders should count once
            const uniqueEmails = [...new Map(threadEmails.map(e => [e.gmailMessageId, e])).values()];

            const latest = uniqueEmails.reduce((a, b) =>
              new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
            );
            const participants = [...new Set(uniqueEmails.map(e => e.fromAddress))].join(', ');
            const allRead = uniqueEmails.every(e => e.isRead);
            const anyStarred = uniqueEmails.some(e => e.isStarred);

            const dbThreadId = db.upsertThread({
              accountId: numAccountId,
              gmailThreadId: threadId,
              subject: latest.subject,
              lastMessageDate: latest.date,
              participants,
              messageCount: uniqueEmails.length,
              snippet: latest.snippet,
              folder,
              isRead: allRead,
              isStarred: anyStarred,
            });

            // Associate this thread with the current folder
            db.upsertThreadFolder(dbThreadId, numAccountId, folder);
          }

          totalNewCount += emails.length;
          log.info(`Synced ${emails.length} emails from ${folder} for account ${accountId}`);

          // Run filter evaluation on newly synced INBOX emails (still inside lock)
          if (folder === 'INBOX') {
            try {
              log.debug(`[SyncService] Triggering filter processing for account ${accountId} after INBOX sync`);
              const filterService = FilterService.getInstance();
              const filterResult = await filterService.processNewEmails(numAccountId);
              log.debug(`[SyncService] Filter processing completed for account ${accountId}: ${filterResult.emailsMatched} matched, ${filterResult.actionsDispatched} actions dispatched`);
            } catch (filterErr) {
              log.warn(`[SyncService] Filter processing failed for INBOX account ${accountId} (continuing):`, filterErr);
            }
          }
        } catch (err) {
          log.warn(`Failed to sync folder ${folder} for account ${accountId}:`, err);
          // Continue with other folders
        } finally {
          // Release the folder lock BEFORE reconciliation so reconcileFolder doesn't deadlock.
          if (releaseLock) releaseLock();
        }

        // --- Folder reconciliation (outside lock) ---
        // Uses UIDs fetched while lock was held above. Full sync always reconciles.
        if (serverUidsForReconcile.length > 0) {
          try {
            await this.reconcileFolderWithServerUids(accountId, folder, serverUidsForReconcile);
            // Mark reconciliation time so IDLE skips it within the next 30s
            this.lastReconciliation.set(`${accountId}:${folder}`, Date.now());
          } catch (reconcileErr) {
            log.warn(`Reconciliation failed for folder ${folder} account ${accountId} (continuing):`, reconcileErr);
          }
        }
      }

      // 4. Update sync state
      db.updateAccountSyncState(numAccountId, new Date().toISOString());

      this.emitProgress({ accountId, folder: '', progress: 100, newCount: totalNewCount, status: 'done' });
      log.info(`Sync complete for account ${accountId}: ${totalNewCount} emails processed`);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown sync error';
      log.error(`Sync failed for account ${accountId}:`, err);
      this.emitProgress({ accountId, folder: '', progress: 0, newCount: 0, status: 'error', error: errorMessage });
    } finally {
      this.syncInProgress.delete(accountId);
    }
  }

  /**
   * Shared folder reconciliation — compares local email_folders UIDs against the
   * server's complete UID set for the given folder.
   *
   * Acquires the folder lock itself to fetch server UIDs, then runs DB cleanup
   * (no lock needed for DB work). Callers that already hold the folder lock must
   * use reconcileFolderWithServerUids() directly to avoid a deadlock.
   *
   * Called by: incrementalFetchFolder (debounced, 30s/folder after releasing lock),
   * and MailQueueService post-flag reconciliation (unstar).
   */
  async reconcileFolder(accountId: string, folder: string): Promise<void> {
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    // Fetch the complete UID set from the server (lightweight SEARCH ALL).
    // Acquire lock here since callers of this public method don't hold it.
    let serverUids: number[];
    const release = await lockManager.acquire(folder);
    try {
      serverUids = await imapService.fetchFolderUids(accountId, folder);
    } finally {
      release();
    }

    await this.reconcileFolderWithServerUids(accountId, folder, serverUids);
  }

  /**
   * DB-only reconciliation given a pre-fetched set of server UIDs.
   * Does NOT acquire the folder lock — caller must have already fetched UIDs
   * (and may still hold the lock or have released it; the DB work is lock-free).
   *
   * Called by syncAccount after it has already fetched emails with the folder lock.
   */
  async reconcileFolderWithServerUids(
    accountId: string,
    folder: string,
    serverUids: number[],
  ): Promise<void> {
    const db = DatabaseService.getInstance();
    const numAccountId = Number(accountId);

    const serverUidSet = new Set(serverUids);

    // Query local DB for all (emailId, uid) pairs associated with this folder
    const localFolderUids = db.getEmailFolderUids(numAccountId, folder);

    // Find stale local entries: present locally but not on server
    const staleEntries = localFolderUids.filter(entry => !serverUidSet.has(entry.uid));

    if (staleEntries.length === 0) {
      return; // Nothing to reconcile
    }

    log.info(`[SyncService] reconcileFolder: removing ${staleEntries.length} stale email-folder associations from ${folder} for account ${accountId}`);

    // Collect affected thread IDs before modifying associations
    const affectedGmailThreadIds = new Set<string>();
    for (const stale of staleEntries) {
      const email = db.getEmailByGmailMessageId(numAccountId, stale.gmailMessageId);
      if (email) {
        const threadId = String(email['gmailThreadId'] || '');
        if (threadId) {
          affectedGmailThreadIds.add(threadId);
        }
      }
    }

    // Remove stale associations in a transaction
    db.getDatabase().run('BEGIN');
    try {
      for (const stale of staleEntries) {
        // Remove email-folder association
        db.removeEmailFolderAssociation(numAccountId, stale.gmailMessageId, folder);

        // Check if the email's thread still has emails in this folder
        const email = db.getEmailByGmailMessageId(numAccountId, stale.gmailMessageId);
        if (email) {
          const threadId = String(email['gmailThreadId'] || '');
          if (threadId && !db.threadHasEmailsInFolder(numAccountId, threadId, folder)) {
            const internalThreadId = db.getThreadInternalId(numAccountId, threadId);
            if (internalThreadId != null) {
              db.removeThreadFolderAssociation(internalThreadId, folder);
              log.debug(`[SyncService] reconcileFolder: removed thread-folder for thread ${threadId} from ${folder}`);
            }
          }
        }
      }
      db.getDatabase().run('COMMIT');
    } catch (err) {
      db.getDatabase().run('ROLLBACK');
      throw err;
    }

    // Remove orphan emails (emails with zero email_folders associations)
    let orphanEmails: Array<{ gmailMessageId: string; gmailThreadId: string }> = [];
    try {
      orphanEmails = db.removeOrphanedEmails(numAccountId);
      if (orphanEmails.length > 0) {
        log.info(`[SyncService] reconcileFolder: removed ${orphanEmails.length} orphan email(s) for account ${accountId}`);
        // Add their thread IDs to the affected set
        for (const orphan of orphanEmails) {
          if (orphan.gmailThreadId) {
            affectedGmailThreadIds.add(orphan.gmailThreadId);
          }
        }
      }
    } catch (orphanErr) {
      log.warn(`[SyncService] reconcileFolder: removeOrphanedEmails failed (continuing):`, orphanErr);
    }

    // Recompute thread metadata for all affected threads
    for (const gmailThreadId of affectedGmailThreadIds) {
      try {
        db.recomputeThreadMetadata(numAccountId, gmailThreadId);
      } catch (recomputeErr) {
        log.warn(`[SyncService] reconcileFolder: recomputeThreadMetadata failed for thread ${gmailThreadId}:`, recomputeErr);
      }
    }

    // Remove orphaned threads (threads with zero thread_folders associations)
    try {
      const orphansRemoved = db.removeOrphanedThreads(numAccountId);
      if (orphansRemoved > 0) {
        log.info(`[SyncService] reconcileFolder: removed ${orphansRemoved} orphaned thread(s) for account ${accountId}`);
      }
    } catch (orphanThreadErr) {
      log.warn(`[SyncService] reconcileFolder: removeOrphanedThreads failed (continuing):`, orphanThreadErr);
    }
  }

  /**
   * Sync all active accounts.
   */
  async syncAllAccounts(): Promise<void> {
    const db = DatabaseService.getInstance();
    const accounts = db.getAccounts();

    const promises = accounts
      .filter(a => !a.needs_reauth)
      .map(a => this.syncAccount(String(a.id)));

    await Promise.allSettled(promises);
  }

  /**
   * Start periodic background sync.
   */
  startBackgroundSync(intervalMs?: number): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
    }

    const db = DatabaseService.getInstance();
    const intervalSetting = db.getSetting('syncInterval');
    const interval = intervalMs || this.parseSyncIntervalMs(intervalSetting);

    this.syncInterval = setInterval(() => {
      this.syncAllAccounts().catch(err => {
        log.error('Background sync failed:', err);
      });
    }, interval);

    log.info(`Background sync started with ${interval / 1000}s interval`);
  }

  private parseSyncIntervalMs(value: string | null): number {
    if (!value) return 300_000;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 300_000;
    // Backward compatibility: older values were stored as minutes.
    if (parsed < 1000) {
      return Math.max(60_000, parsed * 60_000);
    }
    return Math.max(60_000, parsed);
  }

  /**
   * Stop periodic background sync.
   */
  stopBackgroundSync(): void {
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
      log.info('Background sync stopped');
    }
  }

  /**
   * Start IDLE on the inbox for real-time updates.
   * Uses a dedicated IMAP connection. On new mail, performs an incremental
   * folder fetch (not a full sync). Reconnects with exponential backoff on disconnect.
   */
  async startIdle(accountId: string): Promise<void> {
    if (this.idleAccounts.has(accountId)) return;

    try {
      const imapService = ImapService.getInstance();
      this.idleAccounts.add(accountId);
      this.idleReconnectDelay.set(accountId, 2000); // Reset backoff

      // Suppress reconnect during the connection phase (connectIdle tears down
      // any existing IDLE connection, which fires onClose — we don't want that
      // to trigger a reconnect).
      this.idleSuppressReconnect.add(accountId);

      await imapService.startIdle(
        accountId,
        'INBOX',
        // onNewMail callback
        () => {
          // Skip if a full sync is already running (it will pick up new emails)
          if (this.syncInProgress.has(accountId)) {
            log.info(`[IDLE] Skipping incremental fetch — full sync in progress for account ${accountId}`);
            return;
          }
          this.incrementalFetchFolder(accountId, 'INBOX').catch(err => {
            log.error(`[IDLE] Incremental fetch failed for account ${accountId}:`, err);
          });
        },
        // onClose callback — reconnect with backoff (unless intentionally stopped)
        () => {
          this.idleAccounts.delete(accountId);
          if (!this.idleSuppressReconnect.has(accountId)) {
            this.scheduleIdleReconnect(accountId);
          }
        },
        // onError callback
        (err: Error) => {
          log.error(`[IDLE] Connection error for account ${accountId}:`, err);
          this.idleAccounts.delete(accountId);
          if (!this.idleSuppressReconnect.has(accountId)) {
            this.scheduleIdleReconnect(accountId);
          }
        },
      );

      // Connection established — clear suppress flag so future disconnects trigger reconnect
      this.idleSuppressReconnect.delete(accountId);

      log.info(`[IDLE] Started on INBOX for account ${accountId}`);
    } catch (err) {
      this.idleSuppressReconnect.delete(accountId);
      this.idleAccounts.delete(accountId);
      log.warn(`Failed to start IDLE for account ${accountId}:`, err);
      this.scheduleIdleReconnect(accountId);
    }
  }

  /**
   * Schedule an IDLE reconnection with exponential backoff.
   */
  private scheduleIdleReconnect(accountId: string): void {
    // Clear any existing reconnect timer
    const existingTimer = this.idleReconnectTimers.get(accountId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const delay = this.idleReconnectDelay.get(accountId) || 2000;
    log.info(`[IDLE] Scheduling reconnect for account ${accountId} in ${delay}ms`);

    const timer = setTimeout(async () => {
      this.idleReconnectTimers.delete(accountId);

      try {
        // Get a fresh access token (handles refresh automatically)
        const oauthService = OAuthService.getInstance();
        await oauthService.getAccessToken(accountId);
      } catch (err) {
        log.warn(`[IDLE] Token refresh failed for account ${accountId} — stopping IDLE:`, err);
        return; // Don't retry — account likely needs reauth
      }

      await this.startIdle(accountId);
    }, delay);

    this.idleReconnectTimers.set(accountId, timer);

    // Increase backoff: 2s → 4s → 8s → 16s → 32s → 60s cap
    const nextDelay = Math.min(delay * 2, 60_000);
    this.idleReconnectDelay.set(accountId, nextDelay);
  }

  /**
   * Lightweight fetch of latest emails from a single folder (for IDLE-triggered updates).
   * No reconciliation — just fetches recent messages and upserts them.
   * Returns newly-fetched emails for notification purposes.
   */
  async incrementalFetchFolder(accountId: string, folder: string): Promise<NewEmailInfo[]> {
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const numAccountId = Number(accountId);

    const lockManager = FolderLockManager.getInstance();
    let releaseLock: (() => void) | null = null;
    try {
      releaseLock = await lockManager.acquire(folder);
    } catch (lockErr) {
      log.warn(`[IDLE] Failed to acquire lock on ${folder} for incremental fetch:`, lockErr);
      return [];
    }

    try {
      // Baseline: max UID we already have for this folder. Only emails with uid > baseline are "new arrivals".
      const baselineMaxUid = db.getMaxFolderUid(numAccountId, folder);

      // Fetch latest 20 emails (small batch for incremental updates)
      const emails = await imapService.fetchEmails(accountId, folder, { limit: 20 });

      if (emails.length === 0) return [];

      // Track which emails are newly arrived (uid > baseline) for notification only
      const newEmails: NewEmailInfo[] = [];

      // Skip emails with pending queue operations so we don't undo optimistic DB updates.
      const pendingOpService = PendingOpService.getInstance();
      const threadMap = new Map<string, typeof emails>();
      for (const email of emails) {
        const threadId = email.gmailThreadId || email.gmailMessageId;
        const pendingForThread = pendingOpService.getPendingForThread(numAccountId, threadId);
        if (pendingForThread.has(email.gmailMessageId)) {
          log.debug(`[IDLE] Skipping pending message ${email.gmailMessageId} in ${folder}`);
          continue;
        }
        if (!threadMap.has(threadId)) {
          threadMap.set(threadId, []);
        }
        threadMap.get(threadId)!.push(email);
      }

      for (const email of [...threadMap.values()].flat()) {
        db.upsertEmail({
          accountId: numAccountId,
          gmailMessageId: email.gmailMessageId,
          gmailThreadId: email.gmailThreadId,
          folder,
          folderUid: email.uid,
          fromAddress: email.fromAddress,
          fromName: email.fromName,
          toAddresses: email.toAddresses,
          ccAddresses: email.ccAddresses,
          bccAddresses: email.bccAddresses,
          subject: email.subject,
          textBody: email.textBody,
          htmlBody: email.htmlBody,
          date: email.date,
          isRead: email.isRead,
          isStarred: email.isStarred,
          isImportant: email.isImportant,
          isDraft: email.isDraft,
          snippet: email.snippet,
          size: email.size,
          hasAttachments: email.hasAttachments,
          labels: email.labels,
        });

        if (email.fromAddress) {
          db.upsertContact(email.fromAddress, email.fromName);
        }

        // Notify only for messages that arrived after our last known UID (no baseline = establishing, skip notify)
        if (baselineMaxUid !== null && email.uid > baselineMaxUid) {
          newEmails.push({
            gmailMessageId: email.gmailMessageId,
            gmailThreadId: email.gmailThreadId,
            sender: email.fromName || email.fromAddress,
            subject: email.subject,
            snippet: email.snippet,
          });
        }
      }

      // Upsert threads (pending emails already excluded from threadMap)
      for (const [threadId, threadEmails] of threadMap) {
        const uniqueEmails = [...new Map(threadEmails.map(e => [e.gmailMessageId, e])).values()];
        const latest = uniqueEmails.reduce((a, b) =>
          new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
        );
        const participants = [...new Set(uniqueEmails.map(e => e.fromAddress))].join(', ');
        const allRead = uniqueEmails.every(e => e.isRead);
        const anyStarred = uniqueEmails.some(e => e.isStarred);

        const dbThreadId = db.upsertThread({
          accountId: numAccountId,
          gmailThreadId: threadId,
          subject: latest.subject,
          lastMessageDate: latest.date,
          participants,
          messageCount: uniqueEmails.length,
          snippet: latest.snippet,
          folder,
          isRead: allRead,
          isStarred: anyStarred,
        });

        db.upsertThreadFolder(dbThreadId, numAccountId, folder);
      }

      // Run filter evaluation on newly fetched INBOX emails
      if (folder === 'INBOX') {
        try {
          log.debug(`[IDLE] Triggering filter processing for account ${accountId} after incremental INBOX fetch`);
          const filterService = FilterService.getInstance();
          const filterResult = await filterService.processNewEmails(numAccountId);
          log.debug(`[IDLE] Filter processing completed for account ${accountId}: ${filterResult.emailsMatched} matched, ${filterResult.actionsDispatched} actions dispatched`);
        } catch (filterErr) {
          log.warn(`[IDLE] Filter processing failed for INBOX account ${accountId} (continuing):`, filterErr);
        }
      }

      if (newEmails.length > 0) {
        log.info(`[IDLE] Incremental fetch: ${newEmails.length} new email(s) in ${folder} for account ${accountId}`);
        this.accumulateNotification(accountId, folder, newEmails);
      }

      // Schedule debounced reconciliation AFTER the lock is released.
      // We use setImmediate so the finally block runs (releasing the lock) before
      // reconcileFolder tries to acquire it. Only schedule on success paths.
      const IDLE_RECONCILE_INTERVAL_MS = 30_000;
      const reconcileKey = `${accountId}:${folder}`;
      const lastRun = this.lastReconciliation.get(reconcileKey) ?? 0;
      if (Date.now() - lastRun >= IDLE_RECONCILE_INTERVAL_MS) {
        this.lastReconciliation.set(reconcileKey, Date.now());
        setImmediate(() => {
          this.reconcileFolder(accountId, folder).catch((reconcileErr) => {
            log.warn(`[IDLE] Debounced reconciliation failed for ${folder} account ${accountId}:`, reconcileErr);
          });
        });
      } else {
        log.debug(`[IDLE] Skipping reconciliation for ${folder} (last ran ${Math.round((Date.now() - lastRun) / 1000)}s ago)`);
      }

      return newEmails;
    } catch (err) {
      log.error(`[IDLE] Incremental fetch failed for ${folder} account ${accountId}:`, err);
      return [];
    } finally {
      if (releaseLock) releaseLock();
    }
  }

  /**
   * Accumulate new emails for notification batching.
   * On first new email, starts a 3-second timer.
   * When timer fires, emits mail:new-email event and shows desktop notification.
   */
  private accumulateNotification(accountId: string, folder: string, newEmails: NewEmailInfo[]): void {
    let batch = this.notificationBatches.get(accountId);

    if (!batch) {
      // Start a new batch with a 3-second timer
      batch = {
        timer: setTimeout(() => {
          this.flushNotificationBatch(accountId, folder);
        }, 3000),
        emails: [],
      };
      this.notificationBatches.set(accountId, batch);
    }

    batch.emails.push(...newEmails);
  }

  /**
   * Flush the notification batch: emit event to renderer + show desktop notification.
   * Dedupes by gmailMessageId so racing IDLE triggers don't show the same email twice.
   */
  private flushNotificationBatch(accountId: string, folder: string): void {
    const batch = this.notificationBatches.get(accountId);
    this.notificationBatches.delete(accountId);

    if (!batch || batch.emails.length === 0) return;

    const seen = new Set<string>();
    const deduped = batch.emails.filter((e) => {
      if (seen.has(e.gmailMessageId)) return false;
      seen.add(e.gmailMessageId);
      return true;
    });
    if (deduped.length === 0) return;

    const numAccountId = Number(accountId);
    const payload = {
      accountId: numAccountId,
      folder,
      newEmails: deduped,
      totalNewCount: deduped.length,
    };

    // Emit to renderer
    this.emitToRenderer(IPC_EVENTS.MAIL_NEW_EMAIL, payload);

    // Show desktop notification
    this.showDesktopNotification(numAccountId, folder, deduped);
  }

  /**
   * Show an OS-level desktop notification for new emails.
   */
  private showDesktopNotification(accountId: number, folder: string, emails: NewEmailInfo[]): void {
    try {
      if (!Notification.isSupported()) return;

      let title: string;
      let body: string;
      let clickThreadId: string | null = null;

      if (emails.length === 1) {
        const email = emails[0];
        title = email.sender;
        body = email.subject + (email.snippet ? '\n' + email.snippet.substring(0, 100) : '');
        clickThreadId = email.gmailThreadId;
      } else {
        title = `${emails.length} new emails`;
        const senders = [...new Set(emails.map(e => e.sender))];
        if (senders.length <= 2) {
          body = `From ${senders.join(' and ')}`;
        } else {
          body = `From ${senders[0]}, ${senders[1]}, and ${senders.length - 2} other${senders.length - 2 > 1 ? 's' : ''}`;
        }
      }

      const notification = new Notification({ title, body });

      notification.on('click', () => {
        // Focus the app window
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
          if (!win.isDestroyed()) {
            if (win.isMinimized()) win.restore();
            win.focus();
            // Send navigation event to renderer
            win.webContents.send(IPC_EVENTS.MAIL_NOTIFICATION_CLICK, {
              accountId,
              gmailThreadId: clickThreadId || '',
              folder,
            });
          }
        }
      });

      notification.show();
    } catch (err) {
      log.warn('Failed to show desktop notification:', err);
    }
  }

  /**
   * Stop IDLE for a specific account.
   */
  async stopIdle(accountId: string): Promise<void> {
    this.idleAccounts.delete(accountId);

    // Suppress reconnect — this is an intentional stop
    this.idleSuppressReconnect.add(accountId);

    // Clear reconnect timer
    const timer = this.idleReconnectTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.idleReconnectTimers.delete(accountId);
    }

    // Clear notification batch
    const batch = this.notificationBatches.get(accountId);
    if (batch) {
      clearTimeout(batch.timer);
      this.notificationBatches.delete(accountId);
    }

    try {
      const imapService = ImapService.getInstance();
      await imapService.disconnectIdle(accountId);
      log.info(`[IDLE] Stopped for account ${accountId}`);
    } catch (err) {
      log.warn(`Failed to stop IDLE for account ${accountId}:`, err);
    }
  }

  /**
   * Stop all IDLE connections and cleanup.
   */
  async stopAllIdle(): Promise<void> {
    const accountIds = Array.from(this.idleAccounts);
    const promises = accountIds.map(id => this.stopIdle(id));

    // Also clear any reconnect timers for accounts not in idleAccounts
    for (const [accountId, timer] of this.idleReconnectTimers) {
      clearTimeout(timer);
      this.idleReconnectTimers.delete(accountId);
    }

    await Promise.allSettled(promises);
    log.info('[IDLE] All IDLE connections stopped');
  }

  /**
   * Emit sync progress to the renderer process.
   */
  private emitProgress(progress: SyncProgress): void {
    this.emitToRenderer(IPC_EVENTS.MAIL_SYNC, progress);
  }

  /**
   * Emit any event to all renderer windows.
   */
  private emitToRenderer(channel: string, payload: unknown): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(channel, payload);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }
}
