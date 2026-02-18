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
  xGmMsgId: string;
  xGmThrid: string;
  sender: string;
  subject: string;
  snippet: string;
}

interface NotificationBatch {
  timer: ReturnType<typeof setTimeout>;
  emails: NewEmailInfo[];
}

interface MailFolderUpdatedPayload {
  accountId: number;
  folders: string[];
  reason: 'sync' | 'move' | 'delete' | 'flag' | 'send' | 'draft-create' | 'draft-update' | 'filter';
  changeType?: 'new_messages' | 'flag_changes' | 'deletions' | 'mixed';
  count?: number;
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
  /** Debounced retry timers for IDLE incremental fetch lock contention. */
  private idleIncrementalRetryTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
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
          releaseLock = await lockManager.acquire(folder, accountId);
        } catch (lockErr) {
          log.warn(`Sync: failed to acquire lock on ${folder} (skipping):`, lockErr);
          continue;
        }

        // Pre-declare outside try/finally so reconciliation and state persistence can access it.
        let serverUidsForReconcile: number[] = [];
        let shouldReconcile = true;
        let folderChanged = false;
        let folderChangeType: 'new_messages' | 'flag_changes' | 'deletions' | 'mixed' = 'mixed';
        let folderChangeCount = 0;
        let folderUidValidity = '0';
        let folderHighestModseq: string | null = null;
        let folderCondstoreSupported = false;
        let folderSyncSucceeded = false;
        const existingFolderState = db.getFolderState(numAccountId, folder);

        try {
          const fetchLimit = isInitialSync ? 100 : 200;

          // Mailbox status (uidValidity/highestModseq) used for folder_state and UIDVALIDITY reset detection.
          const mailboxStatus = await imapService.getMailboxStatus(accountId, folder);
          folderUidValidity = mailboxStatus.uidValidity;
          folderCondstoreSupported = mailboxStatus.condstoreSupported;
          folderHighestModseq = folderCondstoreSupported ? mailboxStatus.highestModseq : null;

          // UIDVALIDITY reset: wipe folder cache and fail queued ops targeting this folder.
          if (existingFolderState && existingFolderState.uidValidity !== mailboxStatus.uidValidity) {
            log.warn(`[SyncService] UIDVALIDITY changed for ${folder} (account ${accountId}): ${existingFolderState.uidValidity} -> ${mailboxStatus.uidValidity}. Resetting folder cache.`);
            db.wipeFolderData(numAccountId, folder);
            this.invalidateQueueForUidValidityReset(numAccountId, folder);
          }

          let emails: Awaited<ReturnType<typeof imapService.fetchEmails>> = [];
          let newCount = 0;
          let flagChangeCount = 0;

          const canUseCondstore =
            folderCondstoreSupported &&
            !!existingFolderState &&
            existingFolderState.uidValidity === mailboxStatus.uidValidity &&
            existingFolderState.condstoreSupported;

          if (canUseCondstore) {
            const changedSince = existingFolderState.highestModseq ?? '0';
            const changed = await imapService.fetchChangedSince(accountId, folder, changedSince);

            folderUidValidity = changed.uidValidity;
            folderCondstoreSupported = !changed.noModseq;

            const sorted = [...changed.emails].sort((a, b) => {
              const ma = BigInt(a.modseq ?? '0');
              const mb = BigInt(b.modseq ?? '0');
              if (ma < mb) {
                return -1;
              }
              if (ma > mb) {
                return 1;
              }
              return a.uid - b.uid;
            });
            emails = sorted.slice(0, fetchLimit);

            if (emails.length > 0) {
              let maxProcessed = BigInt(changedSince || '0');
              for (const email of emails) {
                const modseq = BigInt(email.modseq ?? '0');
                if (modseq > maxProcessed) {
                  maxProcessed = modseq;
                }
              }
              folderHighestModseq = String(maxProcessed);
            } else {
              folderHighestModseq = changed.highestModseq;
            }

            const lastReconciledAtMs = existingFolderState.lastReconciledAt
              ? Date.parse(existingFolderState.lastReconciledAt)
              : 0;
            shouldReconcile = !lastReconciledAtMs || Number.isNaN(lastReconciledAtMs)
              ? true
              : (Date.now() - lastReconciledAtMs) >= 5 * 60 * 1000;
          } else {
            const hasUsableFolderState =
              !!existingFolderState && existingFolderState.uidValidity === mailboxStatus.uidValidity;
            const folderSinceDate = hasUsableFolderState
              ? sinceDate
              : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
            emails = await imapService.fetchEmails(accountId, folder, {
              limit: fetchLimit,
              since: folderSinceDate,
            });
            shouldReconcile = true;
          }

          // Fetch server UIDs for reconciliation only when due.
          if (shouldReconcile) {
            try {
              serverUidsForReconcile = await imapService.fetchFolderUids(accountId, folder);
            } catch (uidErr) {
              log.warn(`Sync: failed to fetch UIDs for ${folder} (reconciliation will be skipped):`, uidErr);
            }
          }

          // Group emails by thread, excluding those with pending queue operations.
          // Pending emails are skipped entirely — re-upserting them would undo the
          // optimistic folder association update made by the IPC handler.
          const pendingOpService = PendingOpService.getInstance();
          const threadMap = new Map<string, typeof emails>();
          for (const email of emails) {
            const threadId = email.xGmThrid || email.xGmMsgId;
            const pendingForThread = pendingOpService.getPendingForThread(numAccountId, threadId);
            if (pendingForThread.has(email.xGmMsgId)) {
              log.debug(`Sync: skipping pending message ${email.xGmMsgId} in ${folder}`);
              continue; // Skip pending emails entirely
            }

            const alreadyExists = db.getEmailByXGmMsgId(numAccountId, email.xGmMsgId) != null;
            if (alreadyExists) {
              flagChangeCount++;
            } else {
              newCount++;
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
              xGmMsgId: email.xGmMsgId,
              xGmThrid: email.xGmThrid,
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

          // Upsert threads (dedupe emails by xGmMsgId so the same message
          // appearing in multiple folders doesn't inflate counts or create duplicates)
          const affectedThreadIds = new Set<string>();
          for (const [threadId, threadEmails] of threadMap) {
            // Dedupe by xGmMsgId — same message in two folders should count once
            const uniqueEmails = [...new Map(threadEmails.map(e => [e.xGmMsgId, e])).values()];

            const latest = uniqueEmails.reduce((a, b) =>
              new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
            );
            const participants = [...new Set(uniqueEmails.map(e => e.fromAddress))].join(', ');
            const allRead = uniqueEmails.every(e => e.isRead);
            const anyStarred = uniqueEmails.some(e => e.isStarred);

            db.upsertThread({
              accountId: numAccountId,
              xGmThrid: threadId,
              subject: latest.subject,
              lastMessageDate: latest.date,
              participants,
              messageCount: uniqueEmails.length,
              snippet: latest.snippet,
              isRead: allRead,
              isStarred: anyStarred,
            });

            // Associate this thread with the current folder
            db.upsertThreadFolder(numAccountId, threadId, folder);
            affectedThreadIds.add(threadId);
          }

          for (const xGmThrid of affectedThreadIds) {
            try {
              db.recomputeThreadMetadata(numAccountId, xGmThrid);
            } catch (recomputeErr) {
              log.warn(`[SyncService] syncAccount: recomputeThreadMetadata failed for thread ${xGmThrid}:`, recomputeErr);
            }
          }

          totalNewCount += newCount;
          folderChangeCount = newCount + flagChangeCount;
          folderChanged = folderChangeCount > 0;
          if (newCount > 0 && flagChangeCount > 0) {
            folderChangeType = 'mixed';
          } else if (newCount > 0) {
            folderChangeType = 'new_messages';
          } else if (flagChangeCount > 0) {
            folderChangeType = 'flag_changes';
          }

          log.info(
            `[SyncService] Synced ${emails.length} fetched / ${newCount} new / ${flagChangeCount} changed from ${folder} for account ${accountId}`
          );

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

          folderSyncSucceeded = true;
        } catch (err) {
          log.warn(`Failed to sync folder ${folder} for account ${accountId}:`, err);
          // Continue with other folders
        } finally {
          // Release the folder lock BEFORE reconciliation so reconcileFolder doesn't deadlock.
          if (releaseLock) releaseLock();
        }

        if (!folderSyncSucceeded) {
          continue;
        }

        // --- Folder reconciliation (outside lock) ---
        // Uses UIDs fetched while lock was held above.
        let reconciled = false;
        if (shouldReconcile && serverUidsForReconcile.length > 0) {
          try {
            await this.reconcileFolderWithServerUids(accountId, folder, serverUidsForReconcile);
            // Mark reconciliation time so IDLE skips it within the next 30s
            this.lastReconciliation.set(`${accountId}:${folder}`, Date.now());
            reconciled = true;
          } catch (reconcileErr) {
            log.warn(`Reconciliation failed for folder ${folder} account ${accountId} (continuing):`, reconcileErr);
          }
        }

        // Persist CONDSTORE folder state for incremental sync.
        db.upsertFolderState({
          accountId: numAccountId,
          folder,
          uidValidity: folderUidValidity,
          highestModseq: folderCondstoreSupported ? folderHighestModseq : null,
          condstoreSupported: folderCondstoreSupported,
          ...(reconciled ? { lastReconciledAt: new Date().toISOString() } : {}),
        });

        if (folderChanged) {
          this.emitFolderUpdated(numAccountId, [folder], 'sync', folderChangeType, folderChangeCount);
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

  private invalidateQueueForUidValidityReset(accountId: number, folder: string): void {
    try {
      const { MailQueueService } = require('./mail-queue-service') as {
        MailQueueService: {
          getInstance(): {
            failOperationsForFolder: (accountId: number, folder: string, reason: string) => number;
          };
        };
      };
      const invalidated = MailQueueService.getInstance().failOperationsForFolder(
        accountId,
        folder,
        'UIDVALIDITY changed for folder — UIDs are no longer valid',
      );
      if (invalidated > 0) {
        log.warn(`[SyncService] Invalidated ${invalidated} queued operation(s) for ${folder} after UIDVALIDITY reset`);
      }
    } catch (err) {
      log.warn(`[SyncService] Failed to invalidate queue for UIDVALIDITY reset on ${folder}:`, err);
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
    const release = await lockManager.acquire(folder, accountId);
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
      const email = db.getEmailByXGmMsgId(numAccountId, stale.xGmMsgId);
      if (email) {
        const threadId = String(email['xGmThrid'] || '');
        if (threadId) {
          affectedGmailThreadIds.add(threadId);
        }
      }
    }

    // Remove stale associations atomically via a dedicated DB method (owns its own transaction
    // and scheduleSave — avoids mixing manual BEGIN/COMMIT with higher-level DB methods that
    // have their own scheduleSave() side effects).
    db.removeStaleEmailFolderAssociations(numAccountId, folder, staleEntries.map(e => e.xGmMsgId));

    // Remove orphan emails (emails with zero email_folders associations)
    let orphanEmails: Array<{ xGmMsgId: string; xGmThrid: string }> = [];
    try {
      orphanEmails = db.removeOrphanedEmails(numAccountId);
      if (orphanEmails.length > 0) {
        log.info(`[SyncService] reconcileFolder: removed ${orphanEmails.length} orphan email(s) for account ${accountId}`);
        // Add their thread IDs to the affected set
        for (const orphan of orphanEmails) {
          if (orphan.xGmThrid) {
            affectedGmailThreadIds.add(orphan.xGmThrid);
          }
        }
      }
    } catch (orphanErr) {
      log.warn(`[SyncService] reconcileFolder: removeOrphanedEmails failed (continuing):`, orphanErr);
    }

    // Recompute thread metadata for all affected threads
    for (const xGmThrid of affectedGmailThreadIds) {
      try {
        db.recomputeThreadMetadata(numAccountId, xGmThrid);
      } catch (recomputeErr) {
        log.warn(`[SyncService] reconcileFolder: recomputeThreadMetadata failed for thread ${xGmThrid}:`, recomputeErr);
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
      releaseLock = await lockManager.acquire(folder, accountId);
    } catch (lockErr) {
      log.warn(`[IDLE] Failed to acquire lock on ${folder} for incremental fetch:`, lockErr);
      this.scheduleIncrementalRetry(accountId, folder);
      return [];
    }

    try {
      const folderState = db.getFolderState(numAccountId, folder);
      const mailboxStatus = await imapService.getMailboxStatus(accountId, folder);
      let condstoreSupported = mailboxStatus.condstoreSupported;
      let uidValidity = mailboxStatus.uidValidity;
      let highestModseq: string | null = condstoreSupported ? mailboxStatus.highestModseq : null;

      if (folderState && folderState.uidValidity !== uidValidity) {
        log.warn(`[IDLE] UIDVALIDITY changed for ${folder} (account ${accountId}); resetting folder cache`);
        db.wipeFolderData(numAccountId, folder);
        this.invalidateQueueForUidValidityReset(numAccountId, folder);
      }

      let emails: Awaited<ReturnType<typeof imapService.fetchEmails>> = [];
      const canUseCondstore =
        !!folderState &&
        folderState.uidValidity === uidValidity &&
        folderState.condstoreSupported &&
        condstoreSupported;

      if (canUseCondstore) {
        const changedSince = folderState.highestModseq ?? '0';
        const changed = await imapService.fetchChangedSince(accountId, folder, changedSince);
        condstoreSupported = !changed.noModseq;
        uidValidity = changed.uidValidity;

        const sorted = [...changed.emails].sort((a, b) => {
          const ma = BigInt(a.modseq ?? '0');
          const mb = BigInt(b.modseq ?? '0');
          if (ma < mb) {
            return -1;
          }
          if (ma > mb) {
            return 1;
          }
          return a.uid - b.uid;
        });
        emails = sorted.slice(0, 200);

        if (emails.length > 0) {
          let maxProcessed = BigInt(changedSince || '0');
          for (const email of emails) {
            const modseq = BigInt(email.modseq ?? '0');
            if (modseq > maxProcessed) {
              maxProcessed = modseq;
            }
          }
          highestModseq = String(maxProcessed);
        } else {
          highestModseq = changed.highestModseq;
        }
      } else {
        emails = await imapService.fetchEmails(accountId, folder, { limit: 20 });
      }

      if (emails.length === 0) {
        db.upsertFolderState({
          accountId: numAccountId,
          folder,
          uidValidity,
          highestModseq: condstoreSupported ? highestModseq : null,
          condstoreSupported,
        });
        return [];
      }

      const newEmails: NewEmailInfo[] = [];
      let newCount = 0;
      let flagChangeCount = 0;

      // Skip emails with pending queue operations so we don't undo optimistic DB updates.
      const pendingOpService = PendingOpService.getInstance();
      const threadMap = new Map<string, typeof emails>();
      for (const email of emails) {
        const threadId = email.xGmThrid || email.xGmMsgId;
        const pendingForThread = pendingOpService.getPendingForThread(numAccountId, threadId);
        if (pendingForThread.has(email.xGmMsgId)) {
          log.debug(`[IDLE] Skipping pending message ${email.xGmMsgId} in ${folder}`);
          continue;
        }

        const alreadyExists = db.getEmailByXGmMsgId(numAccountId, email.xGmMsgId) != null;
        if (alreadyExists) {
          flagChangeCount++;
        } else {
          newCount++;
        }

        if (!alreadyExists) {
          newEmails.push({
            xGmMsgId: email.xGmMsgId,
            xGmThrid: email.xGmThrid,
            sender: email.fromName || email.fromAddress,
            subject: email.subject,
            snippet: email.snippet,
          });
        }

        if (!threadMap.has(threadId)) {
          threadMap.set(threadId, []);
        }
        threadMap.get(threadId)!.push(email);
      }

      for (const email of [...threadMap.values()].flat()) {
        db.upsertEmail({
          accountId: numAccountId,
          xGmMsgId: email.xGmMsgId,
          xGmThrid: email.xGmThrid,
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
      }

      // Upsert threads (pending emails already excluded from threadMap)
      const affectedThreadIds = new Set<string>();
      for (const [threadId, threadEmails] of threadMap) {
        const uniqueEmails = [...new Map(threadEmails.map(e => [e.xGmMsgId, e])).values()];
        const latest = uniqueEmails.reduce((a, b) =>
          new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
        );
        const participants = [...new Set(uniqueEmails.map(e => e.fromAddress))].join(', ');
        const allRead = uniqueEmails.every(e => e.isRead);
        const anyStarred = uniqueEmails.some(e => e.isStarred);

        db.upsertThread({
          accountId: numAccountId,
          xGmThrid: threadId,
          subject: latest.subject,
          lastMessageDate: latest.date,
          participants,
          messageCount: uniqueEmails.length,
          snippet: latest.snippet,
          isRead: allRead,
          isStarred: anyStarred,
        });

        db.upsertThreadFolder(numAccountId, threadId, folder);
        affectedThreadIds.add(threadId);
      }

      for (const xGmThrid of affectedThreadIds) {
        try {
          db.recomputeThreadMetadata(numAccountId, xGmThrid);
        } catch (recomputeErr) {
          log.warn(`[IDLE] recomputeThreadMetadata failed for thread ${xGmThrid}:`, recomputeErr);
        }
      }

      db.upsertFolderState({
        accountId: numAccountId,
        folder,
        uidValidity,
        highestModseq: condstoreSupported ? highestModseq : null,
        condstoreSupported,
      });

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

      const changeCount = newCount + flagChangeCount;
      if (changeCount > 0) {
        const changeType =
          newCount > 0 && flagChangeCount > 0
            ? 'mixed'
            : newCount > 0
              ? 'new_messages'
              : 'flag_changes';
        this.emitFolderUpdated(numAccountId, [folder], 'sync', changeType, changeCount);
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
   * Dedupes by xGmMsgId so racing IDLE triggers don't show the same email twice.
   */
  private flushNotificationBatch(accountId: string, folder: string): void {
    const batch = this.notificationBatches.get(accountId);
    this.notificationBatches.delete(accountId);

    if (!batch || batch.emails.length === 0) return;

    const seen = new Set<string>();
    const deduped = batch.emails.filter((e) => {
      if (seen.has(e.xGmMsgId)) return false;
      seen.add(e.xGmMsgId);
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
        clickThreadId = email.xGmThrid;
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
              xGmThrid: clickThreadId || '',
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

    // Clear incremental retry timers for this account
    for (const [key, retryTimer] of this.idleIncrementalRetryTimers) {
      if (key.startsWith(`${accountId}:`)) {
        clearTimeout(retryTimer);
        this.idleIncrementalRetryTimers.delete(key);
      }
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

    for (const [retryKey, retryTimer] of this.idleIncrementalRetryTimers) {
      clearTimeout(retryTimer);
      this.idleIncrementalRetryTimers.delete(retryKey);
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

  private scheduleIncrementalRetry(accountId: string, folder: string): void {
    const retryKey = `${accountId}:${folder}`;
    if (this.idleIncrementalRetryTimers.has(retryKey)) {
      return;
    }

    const timer = setTimeout(() => {
      this.idleIncrementalRetryTimers.delete(retryKey);

      if (!this.idleAccounts.has(accountId)) {
        return;
      }
      if (this.syncInProgress.has(accountId)) {
        return;
      }

      this.incrementalFetchFolder(accountId, folder).catch((err) => {
        log.warn(`[IDLE] Incremental retry failed for ${folder} account ${accountId}:`, err);
      });
    }, 2000);

    this.idleIncrementalRetryTimers.set(retryKey, timer);
  }

  private emitFolderUpdated(
    accountId: number,
    folders: string[],
    reason: MailFolderUpdatedPayload['reason'],
    changeType: MailFolderUpdatedPayload['changeType'] = 'mixed',
    count?: number,
  ): void {
    const payload: MailFolderUpdatedPayload = {
      accountId,
      folders,
      reason,
      changeType,
      count,
    };
    this.emitToRenderer(IPC_EVENTS.MAIL_FOLDER_UPDATED, payload);
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
