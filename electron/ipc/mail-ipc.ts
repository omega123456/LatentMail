import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { SmtpService } from '../services/smtp-service';
import { SyncService } from '../services/sync-service';

export function registerMailIpcHandlers(): void {
  const db = DatabaseService.getInstance();

  // Fetch emails/threads for a folder (local-first from DB)
  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_EMAILS, async (_event, accountId: string, folderId: string, options?: { limit?: number; offset?: number }) => {
    try {
      log.info(`Fetching emails for account ${accountId}, folder ${folderId}`);
      const limit = options?.limit || 50;
      const offset = options?.offset || 0;
      const threads = db.getThreadsByFolder(Number(accountId), folderId, limit, offset);
      log.info(`MAIL_FETCH_EMAILS: account=${accountId} folder=${folderId} returned ${threads.length} threads`);
      if (threads.length === 0) {
        // Debug: check what's actually in the DB
        const rawDb = db.getDatabase();
        const threadCount = rawDb.exec('SELECT COUNT(*) FROM threads WHERE account_id = ?', [Number(accountId)]);
        const tfCount = rawDb.exec('SELECT COUNT(*) FROM thread_folders WHERE account_id = ?', [Number(accountId)]);
        const tfFolders = rawDb.exec('SELECT DISTINCT folder FROM thread_folders WHERE account_id = ?', [Number(accountId)]);
        log.info(`DEBUG: total threads=${threadCount[0]?.values[0]?.[0]}, total thread_folders=${tfCount[0]?.values[0]?.[0]}, folders in thread_folders=${JSON.stringify(tfFolders[0]?.values)}`);
      }
      return ipcSuccess(threads);
    } catch (err) {
      log.error('Failed to fetch emails:', err);
      return ipcError('MAIL_FETCH_FAILED', 'Failed to fetch emails');
    }
  });

  // Fetch a full thread with all messages
  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_THREAD, async (_event, accountId: string, threadId: string) => {
    try {
      log.info(`Fetching thread ${threadId} for account ${accountId}`);
      const numAccountId = Number(accountId);

      // Get thread metadata
      const thread = db.getThreadById(numAccountId, threadId);
      if (!thread) {
        return ipcError('MAIL_THREAD_NOT_FOUND', 'Thread not found');
      }

      // Get all messages in this thread
      let messages = db.getEmailsByThreadId(numAccountId, threadId);

      // If any messages are missing bodies, fetch from IMAP
      const missingBodies = messages.filter(
        (m) => !m['htmlBody'] && !m['textBody']
      );
      if (missingBodies.length > 0) {
        try {
          const imapService = ImapService.getInstance();
          const fetchedMessages = await imapService.fetchThread(accountId, threadId);

          // Update DB with fetched bodies
          for (const fetched of fetchedMessages) {
            if (fetched.htmlBody || fetched.textBody) {
              db.upsertEmail({
                accountId: numAccountId,
                gmailMessageId: fetched.gmailMessageId,
                gmailThreadId: fetched.gmailThreadId,
                folder: fetched.folder,
                fromAddress: fetched.fromAddress,
                fromName: fetched.fromName,
                toAddresses: fetched.toAddresses,
                ccAddresses: fetched.ccAddresses,
                bccAddresses: fetched.bccAddresses,
                subject: fetched.subject,
                textBody: fetched.textBody,
                htmlBody: fetched.htmlBody,
                date: fetched.date,
                isRead: fetched.isRead,
                isStarred: fetched.isStarred,
                isImportant: fetched.isImportant,
                snippet: fetched.snippet,
                size: fetched.size,
                hasAttachments: fetched.hasAttachments,
                labels: fetched.labels,
              });
            }
          }

          // Re-fetch messages from DB with bodies
          messages = db.getEmailsByThreadId(numAccountId, threadId);
        } catch (err) {
          log.warn(`Failed to fetch thread bodies from IMAP for ${threadId}:`, err);
          // Continue with what we have from DB
        }
      }

      return ipcSuccess({ ...thread, messages });
    } catch (err) {
      log.error('Failed to fetch thread:', err);
      return ipcError('MAIL_FETCH_THREAD_FAILED', 'Failed to fetch thread');
    }
  });

  // Send an email
  ipcMain.handle(IPC_CHANNELS.MAIL_SEND, async (_event, accountId: string, message: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string;
  }) => {
    try {
      log.info(`Sending email from account ${accountId}`);
      const smtpService = SmtpService.getInstance();
      const result = await smtpService.sendEmail(accountId, message);

      // Trigger a sync to update sent folder
      const syncService = SyncService.getInstance();
      syncService.syncAccount(accountId).catch(err => {
        log.warn('Post-send sync failed:', err);
      });

      return ipcSuccess(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to send email';
      log.error('Failed to send email:', err);
      return ipcError('SMTP_SEND_FAILED', errorMessage);
    }
  });

  // Move messages to a different folder
  ipcMain.handle(IPC_CHANNELS.MAIL_MOVE, async (_event, accountId: string, messageIds: string[], targetFolder: string) => {
    try {
      log.info(`Moving ${messageIds.length} messages to ${targetFolder} for account ${accountId}`);
      const imapService = ImapService.getInstance();

      const numAccountId = Number(accountId);
      const resolvedEmails: Array<Record<string, unknown>> = [];

      for (const id of messageIds) {
        const byMessageId = db.getEmailByGmailMessageId(numAccountId, id);
        if (byMessageId) {
          resolvedEmails.push(byMessageId);
          continue;
        }
        // Backward compatibility: older callers passed thread IDs.
        resolvedEmails.push(...db.getEmailsByThreadId(numAccountId, id));
      }

      const deduped = new Map<string, Record<string, unknown>>();
      for (const email of resolvedEmails) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        if (gmailMessageId) {
          deduped.set(gmailMessageId, email);
        }
      }

      const byFolder = new Map<string, number[]>();
      for (const email of deduped.values()) {
        const folder = String(email['folder'] || '');
        const uid = Number(email['gmailMessageId']);
        if (!folder || !Number.isFinite(uid)) continue;
        if (!byFolder.has(folder)) {
          byFolder.set(folder, []);
        }
        byFolder.get(folder)!.push(uid);
      }

      for (const [sourceFolder, uids] of byFolder.entries()) {
        if (uids.length > 0) {
          await imapService.moveMessages(accountId, sourceFolder, uids, targetFolder);
        }
      }

      // Trigger sync to update local state
      const syncService = SyncService.getInstance();
      syncService.syncAccount(accountId).catch(err => {
        log.warn('Post-move sync failed:', err);
      });

      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to move emails:', err);
      return ipcError('MAIL_MOVE_FAILED', 'Failed to move emails');
    }
  });

  // Toggle flags on messages
  ipcMain.handle(IPC_CHANNELS.MAIL_FLAG, async (_event, accountId: string, messageIds: string[], flag: string, value: boolean) => {
    try {
      log.info(`Setting flag ${flag}=${value} on ${messageIds.length} messages for account ${accountId}`);
      const numAccountId = Number(accountId);

      // Update flags in local DB immediately for responsive UI
      const flagMap: Record<string, { isRead?: boolean; isStarred?: boolean; isImportant?: boolean }> = {
        read: { isRead: value },
        starred: { isStarred: value },
        important: { isImportant: value },
      };
      const resolvedEmails: Array<Record<string, unknown>> = [];
      for (const id of messageIds) {
        const byMessageId = db.getEmailByGmailMessageId(numAccountId, id);
        if (byMessageId) {
          resolvedEmails.push(byMessageId);
          continue;
        }
        // Backward compatibility: older callers passed thread IDs.
        resolvedEmails.push(...db.getEmailsByThreadId(numAccountId, id));
      }

      const deduped = new Map<string, Record<string, unknown>>();
      for (const email of resolvedEmails) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        if (gmailMessageId) {
          deduped.set(gmailMessageId, email);
        }
      }

      const dbFlags = flagMap[flag];
      if (dbFlags) {
        for (const email of deduped.values()) {
          db.updateEmailFlags(numAccountId, String(email['gmailMessageId']), dbFlags);
        }
      }

      // Also update on IMAP server (best-effort)
      try {
        const imapService = ImapService.getInstance();
        const imapFlags: { read?: boolean; starred?: boolean } = {};
        if (flag === 'read') imapFlags.read = value;
        if (flag === 'starred') imapFlags.starred = value;

        if (Object.keys(imapFlags).length > 0) {
          const byFolder = new Map<string, number[]>();
          for (const email of deduped.values()) {
            const folder = String(email['folder'] || '');
            const uid = Number(email['gmailMessageId']);
            if (!folder || !Number.isFinite(uid)) continue;
            if (!byFolder.has(folder)) {
              byFolder.set(folder, []);
            }
            byFolder.get(folder)!.push(uid);
          }

          for (const [folder, uids] of byFolder.entries()) {
            if (uids.length > 0) {
              await imapService.setFlags(accountId, folder, uids, imapFlags);
            }
          }
        }
      } catch (err) {
        log.warn('Failed to update flags on IMAP server:', err);
      }

      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to update flags:', err);
      return ipcError('MAIL_FLAG_FAILED', 'Failed to update email flags');
    }
  });

  // Search emails locally
  ipcMain.handle(IPC_CHANNELS.MAIL_SEARCH, async (_event, accountId: string, query: string) => {
    try {
      log.info(`Searching "${query}" for account ${accountId}`);
      const results = db.searchEmails(Number(accountId), query);
      return ipcSuccess(results);
    } catch (err) {
      log.error('Failed to search:', err);
      return ipcError('MAIL_SEARCH_FAILED', 'Failed to search emails');
    }
  });

  // Trigger manual sync for an account
  ipcMain.handle(IPC_CHANNELS.MAIL_SYNC_ACCOUNT, async (_event, accountId: string) => {
    try {
      log.info(`Manual sync triggered for account ${accountId}`);
      const syncService = SyncService.getInstance();
      await syncService.syncAccount(accountId);
      return ipcSuccess(null);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Sync failed';
      log.error('Manual sync failed:', err);
      return ipcError('MAIL_SYNC_FAILED', errorMessage);
    }
  });

  // Get folder list for an account
  ipcMain.handle(IPC_CHANNELS.MAIL_GET_FOLDERS, async (_event, accountId: string) => {
    try {
      log.info(`Getting folders for account ${accountId}`);
      const labels = db.getLabelsByAccount(Number(accountId));
      return ipcSuccess(labels);
    } catch (err) {
      log.error('Failed to get folders:', err);
      return ipcError('MAIL_GET_FOLDERS_FAILED', 'Failed to get folders');
    }
  });
}
