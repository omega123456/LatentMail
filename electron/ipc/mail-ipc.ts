import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { SmtpService } from '../services/smtp-service';
import { SyncService } from '../services/sync-service';

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

  // Move messages to a different folder
  ipcMain.handle(IPC_CHANNELS.MAIL_MOVE, async (_event, accountId: string, messageIds: string[], targetFolder: string, sourceFolder?: string) => {
    try {
      log.info(`Moving ${messageIds.length} messages to ${targetFolder} for account ${accountId} (sourceFolder=${sourceFolder || 'auto'})`);
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

      // Handle orphan threads: if the caller sent a single ID that resolved to zero
      // emails (e.g. an orphan draft thread with no email rows), clean up its
      // thread_folders entry for the source folder so it disappears from the list.
      // Safety: only remove if the thread truly has zero emails in the DB to avoid
      // hiding valid threads due to DB staleness or Message-ID normalization issues.
      if (deduped.size === 0 && messageIds.length === 1 && sourceFolder) {
        const orphanThreadId = messageIds[0];
        // Confirm this is not a known message ID
        const asEmail = db.getEmailByGmailMessageId(numAccountId, orphanThreadId);
        if (!asEmail) {
          // Verify the thread has zero emails before removing — prevents false cleanup
          const threadEmails = db.getEmailsByThreadId(numAccountId, orphanThreadId);
          if (threadEmails.length === 0) {
            const internalThreadId = db.getThreadInternalId(numAccountId, orphanThreadId);
            if (internalThreadId != null) {
              db.removeThreadFolderAssociation(internalThreadId, sourceFolder);
              log.info(`MAIL_MOVE: Removed orphan thread ${orphanThreadId} (internal ${internalThreadId}) from folder ${sourceFolder}`);
            } else {
              log.warn(`MAIL_MOVE: Orphan thread ${orphanThreadId} has no internal thread ID — cannot clean up`);
            }
            return ipcSuccess(null);
          } else {
            log.warn(`MAIL_MOVE: Thread ${orphanThreadId} has ${threadEmails.length} emails but none resolved via message ID — skipping orphan cleanup`);
          }
        }
      }

      // Group messages by source folder using getFolderUidsForEmail (resolves Message-ID → per-folder UIDs)
      const byFolder = new Map<string, number[]>();
      // Track which gmailMessageId maps to which source folders for post-move DB update
      const emailSourceFolders = new Map<string, Set<string>>();
      for (const email of deduped.values()) {
        const gmailMessageId = String(email['gmailMessageId'] || '');
        const folderUids = db.getFolderUidsForEmail(numAccountId, gmailMessageId);

        if (folderUids.length === 0) {
          log.warn(`MAIL_MOVE: No folder UIDs found for email ${gmailMessageId} — IMAP move skipped (will resolve on next sync)`);
        }

        if (sourceFolder) {
          // Explicit source folder from the frontend — find the UID for this folder
          const entry = folderUids.find(fu => fu.folder === sourceFolder);
          if (entry) {
            if (!byFolder.has(sourceFolder)) byFolder.set(sourceFolder, []);
            byFolder.get(sourceFolder)!.push(entry.uid);
            if (!emailSourceFolders.has(gmailMessageId)) emailSourceFolders.set(gmailMessageId, new Set());
            emailSourceFolders.get(gmailMessageId)!.add(sourceFolder);
          }
        } else {
          // Resolve all folders from the email_folders link table
          for (const { folder, uid } of folderUids) {
            if (!byFolder.has(folder)) byFolder.set(folder, []);
            byFolder.get(folder)!.push(uid);
            if (!emailSourceFolders.has(gmailMessageId)) emailSourceFolders.set(gmailMessageId, new Set());
            emailSourceFolders.get(gmailMessageId)!.add(folder);
          }
        }
      }

      for (const [folder, uids] of byFolder.entries()) {
        if (uids.length > 0) {
          await imapService.moveMessages(accountId, folder, uids, targetFolder);
        }
      }

      // Update local DB folder associations directly instead of triggering a full sync.
      for (const [srcFolder] of byFolder.entries()) {
        if (srcFolder === targetFolder) continue;

        for (const email of deduped.values()) {
          const gmailMessageId = String(email['gmailMessageId'] || '');
          const gmailThreadId = String(email['gmailThreadId'] || '');
          const sources = emailSourceFolders.get(gmailMessageId);
          if (!gmailMessageId || !sources || !sources.has(srcFolder)) continue;

          // Move this email's folder association from source to target
          // New UID in target folder is unknown until next sync — pass null
          db.moveEmailFolder(numAccountId, gmailMessageId, srcFolder, targetFolder, null);

          // Move thread-folder association if thread has no more emails in source
          if (gmailThreadId) {
            const internalThreadId = db.getThreadInternalId(numAccountId, gmailThreadId);
            if (internalThreadId != null) {
              if (!db.threadHasEmailsInFolder(numAccountId, gmailThreadId, srcFolder)) {
                db.moveThreadFolder(internalThreadId, numAccountId, srcFolder, targetFolder);
              } else {
                // Thread still has emails in source folder — just add the target association
                db.upsertThreadFolder(internalThreadId, numAccountId, targetFolder);
              }
            }
          }
        }
      }

      log.info(`Move complete: ${deduped.size} emails moved to ${targetFolder}, local DB updated`);

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
          // Group by folder using getFolderUidsForEmail (resolves Message-ID → per-folder UIDs)
          const byFolder = new Map<string, number[]>();
          for (const email of deduped.values()) {
            const gmailMessageId = String(email['gmailMessageId'] || '');
            const folderUids = db.getFolderUidsForEmail(numAccountId, gmailMessageId);
            if (folderUids.length === 0) {
              log.warn(`MAIL_FLAG: No folder UIDs found for email ${gmailMessageId} — IMAP flag update skipped (will resolve on next sync)`);
            }
            for (const { folder, uid } of folderUids) {
              if (!byFolder.has(folder)) byFolder.set(folder, []);
              byFolder.get(folder)!.push(uid);
            }
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
