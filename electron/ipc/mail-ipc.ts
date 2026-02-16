import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { SmtpService } from '../services/smtp-service';
import { SyncService } from '../services/sync-service';
import { MailQueueService } from '../services/mail-queue-service';

// Threads we've already attempted to fetch bodies for this process (avoids infinite re-fetch for orphans).
const threadBodyFetchAttempted = new Set<string>();

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
      log.info(`FETCH_THREAD: ${messages.length} messages from DB for thread ${threadId}`);

      // Fetch from IMAP when any messages are missing bodies (e.g. after partial sync).
      // Guard: only attempt once per thread per process to avoid infinite re-fetch for
      // orphans that IMAP's thread search doesn't return.
      const missingBodies = messages.filter(
        (m) => !m['htmlBody'] && !m['textBody']
      );
      const fetchKey = `${accountId}:${threadId}`;
      const shouldFetch =
        missingBodies.length > 0 && !threadBodyFetchAttempted.has(fetchKey);
      if (shouldFetch) {
        threadBodyFetchAttempted.add(fetchKey);
        log.info(`FETCH_THREAD: ${missingBodies.length}/${messages.length} messages missing bodies — fetching from IMAP`);

        try {
          const imapService = ImapService.getInstance();
          const fetchedMessages = await imapService.fetchThread(accountId, threadId);
          log.info(`FETCH_THREAD: IMAP returned ${fetchedMessages.length} messages for thread ${threadId}`);

          // Update DB with fetched bodies
          for (const fetched of fetchedMessages) {
            if (fetched.htmlBody || fetched.textBody) {
              db.upsertEmail({
                accountId: numAccountId,
                gmailMessageId: fetched.gmailMessageId,
                gmailThreadId: fetched.gmailThreadId,
                folder: fetched.folder,
                folderUid: fetched.uid,
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

      // No full sync after send — the sent message will appear in Sent folder
      // on the next scheduled background sync or IDLE event. Draft cleanup
      // is not handled here — it will be moved to the queue system in Phase 3.

      return ipcSuccess(result);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to send email';
      log.error('Failed to send email:', err);
      return ipcError('SMTP_SEND_FAILED', errorMessage);
    }
  });

  // Move messages to a different folder (via queue)
  ipcMain.handle(IPC_CHANNELS.MAIL_MOVE, async (_event, accountId: string, messageIds: string[], targetFolder: string, sourceFolder?: string) => {
    try {
      log.info(`Enqueuing move of ${messageIds.length} messages to ${targetFolder} for account ${accountId}`);
      const queueService = MailQueueService.getInstance();

      const numAccountId = Number(accountId);
      const resolvedEmails: Array<Record<string, unknown>> = [];

      for (const id of messageIds) {
        const byMessageId = db.getEmailByGmailMessageId(numAccountId, id);
        if (byMessageId) {
          resolvedEmails.push(byMessageId);
          continue;
        }
        resolvedEmails.push(...db.getEmailsByThreadId(numAccountId, id));
      }

      const deduped = new Map<string, Record<string, unknown>>();
      for (const email of resolvedEmails) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        if (gmailMessageId) {
          deduped.set(gmailMessageId, email);
        }
      }

      // Handle orphan threads (zero emails) — clean up immediately
      if (deduped.size === 0 && messageIds.length === 1 && sourceFolder) {
        const orphanThreadId = messageIds[0];
        const asEmail = db.getEmailByGmailMessageId(numAccountId, orphanThreadId);
        if (!asEmail) {
          const threadEmails = db.getEmailsByThreadId(numAccountId, orphanThreadId);
          if (threadEmails.length === 0) {
            const internalThreadId = db.getThreadInternalId(numAccountId, orphanThreadId);
            if (internalThreadId != null) {
              db.removeThreadFolderAssociation(internalThreadId, sourceFolder);
              log.info(`MAIL_MOVE: Removed orphan thread ${orphanThreadId} from ${sourceFolder}`);
            }
            return ipcSuccess(null);
          }
        }
      }

      // CRITICAL: Snapshot UIDs BEFORE optimistic DB update.
      // The queue worker uses these pre-resolved UIDs for the IMAP operation.
      const resolvedUids: Record<string, number[]> = {};
      const resolvedEmailsMeta: Array<{ gmailMessageId: string; gmailThreadId: string }> = [];

      for (const email of deduped.values()) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        const gmailThreadId = String(email['gmailThreadId'] || '');
        const folderUids = db.getFolderUidsForEmail(numAccountId, gmailMessageId);

        resolvedEmailsMeta.push({ gmailMessageId, gmailThreadId });

        if (sourceFolder) {
          const entry = folderUids.find(fu => fu.folder === sourceFolder);
          if (entry) {
            if (!resolvedUids[sourceFolder]) resolvedUids[sourceFolder] = [];
            resolvedUids[sourceFolder].push(entry.uid);
          }
        } else {
          for (const { folder, uid } of folderUids) {
            if (!resolvedUids[folder]) resolvedUids[folder] = [];
            resolvedUids[folder].push(uid);
          }
        }
      }

      // Optimistic local DB update for folder associations (after UID snapshot).
      // Iterate all resolved source folders (handles both explicit sourceFolder and auto-resolved).
      const sourceFolders = Object.keys(resolvedUids);
      for (const srcFolder of sourceFolders) {
        if (srcFolder === targetFolder) continue;

        for (const email of deduped.values()) {
          const gmailMessageId = String(email['gmailMessageId'] || '');
          const gmailThreadId = String(email['gmailThreadId'] || '');
          if (!gmailMessageId) continue;

          // Check if this email is actually in this source folder
          const folderUids = db.getFolderUidsForEmail(numAccountId, gmailMessageId);
          const inFolder = folderUids.some(fu => fu.folder === srcFolder);
          if (!inFolder) continue;

          db.moveEmailFolder(numAccountId, gmailMessageId, srcFolder, targetFolder, null);

          if (gmailThreadId) {
            const internalThreadId = db.getThreadInternalId(numAccountId, gmailThreadId);
            if (internalThreadId != null) {
              if (!db.threadHasEmailsInFolder(numAccountId, gmailThreadId, srcFolder)) {
                db.moveThreadFolder(internalThreadId, numAccountId, srcFolder, targetFolder);
              } else {
                db.upsertThreadFolder(internalThreadId, numAccountId, targetFolder);
              }
            }
          }
        }
      }

      const description = `Move ${messageIds.length} email(s) to ${targetFolder}`;
      const queueId = queueService.enqueue(
        numAccountId,
        'move',
        {
          messageIds,
          sourceFolder,
          targetFolder,
          resolvedUids,
          resolvedEmails: resolvedEmailsMeta,
        },
        description,
      );

      return ipcSuccess({ queueId });
    } catch (err) {
      log.error('Failed to enqueue move:', err);
      return ipcError('MAIL_MOVE_FAILED', 'Failed to move emails');
    }
  });

  // Toggle flags on messages (via queue)
  ipcMain.handle(IPC_CHANNELS.MAIL_FLAG, async (_event, accountId: string, messageIds: string[], flag: string, value: boolean) => {
    try {
      log.info(`Enqueuing flag ${flag}=${value} on ${messageIds.length} messages for account ${accountId}`);
      const numAccountId = Number(accountId);
      const queueService = MailQueueService.getInstance();

      // Resolve emails and snapshot UIDs BEFORE optimistic DB update
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
        resolvedEmails.push(...db.getEmailsByThreadId(numAccountId, id));
      }

      const deduped = new Map<string, Record<string, unknown>>();
      for (const email of resolvedEmails) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        if (gmailMessageId) {
          deduped.set(gmailMessageId, email);
        }
      }

      // Snapshot UIDs BEFORE optimistic update (prevents race with optimistic move updates)
      const resolvedUids: Record<string, number[]> = {};
      for (const email of deduped.values()) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        const folderUids = db.getFolderUidsForEmail(numAccountId, gmailMessageId);
        for (const { folder, uid } of folderUids) {
          if (!resolvedUids[folder]) resolvedUids[folder] = [];
          resolvedUids[folder].push(uid);
        }
      }

      // Optimistic local DB update: set flags immediately for responsive UI
      const dbFlags = flagMap[flag];
      if (dbFlags) {
        for (const email of deduped.values()) {
          db.updateEmailFlags(numAccountId, String(email['gmailMessageId']), dbFlags);
        }
      }

      // Enqueue the IMAP flag update via the queue
      const description = `Flag: ${flag}=${value} on ${messageIds.length} email(s)`;
      const queueId = queueService.enqueue(
        numAccountId,
        'flag',
        { messageIds, flag, value, resolvedUids },
        description,
      );

      return ipcSuccess({ queueId });
    } catch (err) {
      log.error('Failed to enqueue flag update:', err);
      return ipcError('MAIL_FLAG_FAILED', 'Failed to update email flags');
    }
  });

  // Delete messages (via queue)
  ipcMain.handle(IPC_CHANNELS.MAIL_DELETE, async (_event, accountId: string, messageIds: string[], folder: string) => {
    try {
      log.info(`Enqueuing delete of ${messageIds.length} messages from ${folder} for account ${accountId}`);
      const numAccountId = Number(accountId);
      const queueService = MailQueueService.getInstance();

      const isPermanent = folder === '[Gmail]/Trash';

      const resolvedEmails: Array<Record<string, unknown>> = [];
      for (const id of messageIds) {
        const byMessageId = db.getEmailByGmailMessageId(numAccountId, id);
        if (byMessageId) {
          resolvedEmails.push(byMessageId);
          continue;
        }
        resolvedEmails.push(...db.getEmailsByThreadId(numAccountId, id));
      }

      const deduped = new Map<string, Record<string, unknown>>();
      for (const email of resolvedEmails) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        if (gmailMessageId) {
          deduped.set(gmailMessageId, email);
        }
      }

      // CRITICAL: Snapshot UIDs BEFORE optimistic DB update.
      const resolvedUids: number[] = [];
      const resolvedEmailsMeta: Array<{ gmailMessageId: string; gmailThreadId: string }> = [];

      for (const email of deduped.values()) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        const gmailThreadId = String(email['gmailThreadId'] || '');
        resolvedEmailsMeta.push({ gmailMessageId, gmailThreadId });

        const folderUids = db.getFolderUidsForEmail(numAccountId, gmailMessageId);
        const entry = folderUids.find(fu => fu.folder === folder);
        if (entry) {
          resolvedUids.push(entry.uid);
        }
      }

      // Optimistic DB update (after UID snapshot)
      if (isPermanent) {
        for (const email of deduped.values()) {
          db.removeEmailAndAssociations(numAccountId, String(email['gmailMessageId']));
        }
      } else {
        for (const email of deduped.values()) {
          const gmailMessageId = String(email['gmailMessageId'] || '');
          const gmailThreadId = String(email['gmailThreadId'] || '');
          if (!gmailMessageId) continue;

          db.moveEmailFolder(numAccountId, gmailMessageId, folder, '[Gmail]/Trash', null);

          if (gmailThreadId) {
            const internalThreadId = db.getThreadInternalId(numAccountId, gmailThreadId);
            if (internalThreadId != null) {
              if (!db.threadHasEmailsInFolder(numAccountId, gmailThreadId, folder)) {
                db.moveThreadFolder(internalThreadId, numAccountId, folder, '[Gmail]/Trash');
              } else {
                db.upsertThreadFolder(internalThreadId, numAccountId, '[Gmail]/Trash');
              }
            }
          }
        }
      }

      const description = `Delete ${messageIds.length} email(s) from ${folder}`;
      const queueId = queueService.enqueue(
        numAccountId,
        'delete',
        {
          messageIds,
          folder,
          resolvedUids,
          resolvedEmails: resolvedEmailsMeta,
          permanent: isPermanent,
        },
        description,
      );

      return ipcSuccess({ queueId });
    } catch (err) {
      log.error('Failed to enqueue delete:', err);
      return ipcError('MAIL_DELETE_FAILED', 'Failed to delete emails');
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
