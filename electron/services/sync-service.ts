import { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { ImapService } from './imap-service';
import { DatabaseService } from './database-service';
import { IPC_EVENTS } from '../ipc/ipc-channels';

/** Gmail special-use folder mappings */
const GMAIL_FOLDER_MAP: Record<string, { name: string; icon: string }> = {
  '\\Inbox': { name: 'Inbox', icon: 'inbox' },
  '\\Drafts': { name: 'Drafts', icon: 'edit_note' },
  '\\Sent': { name: 'Sent', icon: 'send' },
  '\\Trash': { name: 'Trash', icon: 'delete' },
  '\\Junk': { name: 'Spam', icon: 'report' },
  '\\All': { name: 'All Mail', icon: 'all_inbox' },
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

export class SyncService {
  private static instance: SyncService;
  private syncInterval: ReturnType<typeof setInterval> | null = null;
  private syncInProgress: Set<string> = new Set();
  private idleAccounts: Set<string> = new Set();

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

      // 3. Sync priority folders first, then others
      const allFolders = mailboxes
        .filter(mb => mb.listed && mb.messages > 0)
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

        try {
          const fetchLimit = isInitialSync ? 100 : 200;
          const emails = await imapService.fetchEmails(accountId, folder, {
            limit: fetchLimit,
            since: sinceDate,
          });

          // Group emails by thread
          const threadMap = new Map<string, typeof emails>();
          for (const email of emails) {
            const threadId = email.gmailThreadId || email.gmailMessageId;
            if (!threadMap.has(threadId)) {
              threadMap.set(threadId, []);
            }
            threadMap.get(threadId)!.push(email);
          }

          // Store emails and build threads
          for (const email of emails) {
            db.upsertEmail({
              accountId: numAccountId,
              gmailMessageId: email.gmailMessageId,
              gmailThreadId: email.gmailThreadId,
              folder,
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

          // Upsert threads
          for (const [threadId, threadEmails] of threadMap) {
            const latest = threadEmails.reduce((a, b) =>
              new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
            );
            const participants = [...new Set(threadEmails.map(e => e.fromAddress))].join(', ');
            const allRead = threadEmails.every(e => e.isRead);
            const anyStarred = threadEmails.some(e => e.isStarred);

            db.upsertThread({
              accountId: numAccountId,
              gmailThreadId: threadId,
              subject: latest.subject,
              lastMessageDate: latest.date,
              participants,
              messageCount: threadEmails.length,
              snippet: latest.snippet,
              folder,
              isRead: allRead,
              isStarred: anyStarred,
            });
          }

          totalNewCount += emails.length;
          log.info(`Synced ${emails.length} emails from ${folder} for account ${accountId}`);
        } catch (err) {
          log.warn(`Failed to sync folder ${folder} for account ${accountId}:`, err);
          // Continue with other folders
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
   */
  async startIdle(accountId: string): Promise<void> {
    if (this.idleAccounts.has(accountId)) return;

    try {
      const imapService = ImapService.getInstance();
      await imapService.startIdle(accountId, 'INBOX', () => {
        // When new mail arrives, trigger an incremental sync
        this.syncAccount(accountId).catch(err => {
          log.error(`IDLE-triggered sync failed for account ${accountId}:`, err);
        });
      });
      this.idleAccounts.add(accountId);
      log.info(`IDLE started on INBOX for account ${accountId}`);
    } catch (err) {
      log.warn(`Failed to start IDLE for account ${accountId}:`, err);
    }
  }

  /**
   * Emit sync progress to the renderer process.
   */
  private emitProgress(progress: SyncProgress): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.MAIL_SYNC, progress);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }
}
