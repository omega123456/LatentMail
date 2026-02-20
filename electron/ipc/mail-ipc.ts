import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { SyncService } from '../services/sync-service';
import { MailQueueService } from '../services/mail-queue-service';
import { FolderLockManager } from '../services/folder-lock-manager';
import { PendingOpService } from '../services/pending-op-service';

// threadBodyFetchAttempted now lives on PendingOpService to avoid circular imports
// between mail-ipc.ts and mail-queue-service.ts. Access via:
//   PendingOpService.getInstance().threadBodyFetchAttempted

export function registerMailIpcHandlers(): void {
  const db = DatabaseService.getInstance();

  /**
   * Build thread response object (thread metadata + messages with folders).
   * Shared by MAIL_FETCH_THREAD and MAIL_GET_THREAD_FROM_DB.
   */
  function buildThreadResponse(
    thread: Record<string, unknown>,
    messages: Array<Record<string, unknown>>,
    pendingIds: Set<string>,
    numAccountId: number
  ): Record<string, unknown> {
    const messagesWithFolders: Array<Record<string, unknown>> = messages.map((m) => {
      const xGmMsgId = String(m['xGmMsgId'] ?? '');
      const folders = xGmMsgId ? db.getFoldersForEmail(numAccountId, xGmMsgId) : [];
      return { ...m, folders };
    });
    let threadResponse: Record<string, unknown> = { ...thread };
    if (pendingIds.size > 0 && messagesWithFolders.length > 0) {
      const msgCount = messagesWithFolders.length;
      const parseTs = (d: unknown): number => {
        if (typeof d === 'number') {
          return Number.isFinite(d) ? d : 0;
        }
        const parsed = Date.parse(String(d));
        return Number.isFinite(parsed) ? parsed : 0;
      };
      const latestMsg = messagesWithFolders.reduce((a, b) => {
        return parseTs(b['date']) > parseTs(a['date']) ? b : a;
      });
      const allRead = messagesWithFolders.every((m) => m['isRead'] === true);
      const anyStarred = messagesWithFolders.some((m) => m['isStarred'] === true);
      const participants = [...new Set(messagesWithFolders.map((m) => String(m['fromAddress'] ?? '')))].join(', ');

      threadResponse = {
        ...threadResponse,
        messageCount: msgCount,
        snippet: String(latestMsg['snippet'] ?? ''),
        lastMessageDate: latestMsg['date'] != null ? String(latestMsg['date']) : String(threadResponse['lastMessageDate'] ?? ''),
        isRead: allRead,
        isStarred: anyStarred,
        participants,
      };
    } else if (pendingIds.size > 0 && messagesWithFolders.length === 0) {
      threadResponse = {
        ...threadResponse,
        messageCount: 0,
        snippet: '',
        participants: '',
        lastMessageDate: '',
        isRead: true,
        isStarred: false,
      };
    }
    return { ...threadResponse, messages: messagesWithFolders };
  }

  const normalizeSearchQueries = (queryInput: unknown): string[] => {
    if (typeof queryInput === 'string') {
      const trimmed = queryInput.trim();
      return trimmed ? [trimmed] : [];
    }
    if (Array.isArray(queryInput)) {
      return queryInput
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    }
    return [];
  };

  const attachThreadFolders = (threads: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
    const threadIds = threads
      .map((thread) => {
        const rawId = thread['id'];
        if (typeof rawId === 'number') {
          return rawId;
        }
        if (typeof rawId === 'string') {
          const parsed = Number(rawId);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      })
      .filter((threadId): threadId is number => threadId != null && threadId > 0);

    if (threadIds.length === 0) {
      return threads;
    }

    const folderMap = db.getFoldersForThreadBatch(threadIds);
    return threads.map((thread) => {
      const rawId = thread['id'];
      const threadId = typeof rawId === 'number' ? rawId : Number(rawId);
      const folders = Number.isFinite(threadId) ? folderMap.get(threadId) : undefined;
      if (!folders || folders.length === 0) {
        return thread;
      }
      return { ...thread, folders };
    });
  };

  /**
   * Enrich threads with label info from user_labels.
   * Adds a `label` field to each thread if any of its emails has a label assigned.
   */
  const attachThreadLabels = (threads: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
    const threadIds = threads
      .map((thread) => {
        const rawId = thread['id'];
        if (typeof rawId === 'number') {
          return rawId;
        }
        if (typeof rawId === 'string') {
          const parsed = Number(rawId);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      })
      .filter((threadId): threadId is number => threadId != null && threadId > 0);

    if (threadIds.length === 0) {
      return threads;
    }

    const labelMap = db.getLabelsForThreadBatch(threadIds);
    if (labelMap.size === 0) {
      return threads;
    }

    return threads.map((thread) => {
      const rawId = thread['id'];
      const threadId = typeof rawId === 'number' ? rawId : Number(rawId);
      const labelInfo = Number.isFinite(threadId) ? labelMap.get(threadId) : undefined;
      if (!labelInfo) {
        return thread;
      }
      return {
        ...thread,
        label: {
          id: labelInfo.labelId,
          name: labelInfo.labelName,
          color: labelInfo.labelColor,
        },
      };
    });
  };

  /**
   * Enrich threads with hasDraft status.
   * For each thread, checks if any constituent email has is_draft=1.
   * Follows the same pattern as attachThreadFolders/attachThreadLabels.
   */
  const attachThreadDraftStatus = (threads: Array<Record<string, unknown>>): Array<Record<string, unknown>> => {
    const threadIds = threads
      .map((thread) => {
        const rawId = thread['id'];
        if (typeof rawId === 'number') {
          return rawId;
        }
        if (typeof rawId === 'string') {
          const parsed = Number(rawId);
          return Number.isFinite(parsed) ? parsed : null;
        }
        return null;
      })
      .filter((threadId): threadId is number => threadId != null && threadId > 0);

    if (threadIds.length === 0) {
      return threads;
    }

    const draftThreadIds = db.getThreadIdsWithDrafts(threadIds);
    if (draftThreadIds.size === 0) {
      return threads;
    }

    return threads.map((thread) => {
      const rawId = thread['id'];
      const threadId = typeof rawId === 'number' ? rawId : Number(rawId);
      if (Number.isFinite(threadId) && draftThreadIds.has(threadId)) {
        return { ...thread, hasDraft: true };
      }
      return thread;
    });
  };

  // Fetch emails/threads for a folder (local-first from DB)
  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_EMAILS, async (_event, accountId: string, folderId: string, options?: { limit?: number; offset?: number }) => {
    try {
      log.info(`Fetching emails for account ${accountId}, folder ${folderId}`);
      const limit = options?.limit || 50;
      const offset = options?.offset || 0;
      const numAccountId = Number(accountId);

      // Handle virtual label folder: label::<id>
      if (folderId.startsWith('label::')) {
        const labelId = Number(folderId.substring(7));
        if (!Number.isFinite(labelId) || labelId <= 0) {
          return ipcError('MAIL_INVALID_FOLDER', `Invalid label folder ID: ${folderId}`);
        }
        let threads = db.getThreadsByUserLabel(numAccountId, labelId, limit, offset);
        threads = attachThreadFolders(threads);
        threads = attachThreadLabels(threads);
        threads = attachThreadDraftStatus(threads);
        return ipcSuccess(threads);
      }

      let threads = db.getThreadsByFolder(numAccountId, folderId, limit, offset);
      log.info(`MAIL_FETCH_EMAILS: account=${accountId} folder=${folderId} returned ${threads.length} threads`);

      // Targeted IMAP fallback for [Gmail]/Starred: if the local DB returns zero
      // threads on the first page, fetch from server to populate folder associations.
      // This handles the case where starred messages exist on the server but
      // thread_folders for [Gmail]/Starred are stale or not yet synced.
      if (threads.length === 0 && offset === 0 && folderId === '[Gmail]/Starred') {
        log.info(`MAIL_FETCH_EMAILS: [Gmail]/Starred is empty locally — fetching from IMAP`);
        try {
          const imapService = ImapService.getInstance();
          const lockManager = FolderLockManager.getInstance();

          let emails: Awaited<ReturnType<typeof imapService.fetchEmails>>;
          const release = await lockManager.acquire(folderId, accountId);
          try {
            emails = await imapService.fetchEmails(accountId, folderId, { limit: 100 });
          } finally {
            release();
          }

          if (emails.length > 0) {
            // Group by thread for upsert
            const threadMap = new Map<string, typeof emails>();
            for (const email of emails) {
              const threadId = email.xGmThrid || email.xGmMsgId;
              if (!threadMap.has(threadId)) {
                threadMap.set(threadId, []);
              }
              threadMap.get(threadId)!.push(email);
            }

            // Upsert emails
            for (const email of emails) {
              db.upsertEmail({
                accountId: numAccountId,
                xGmMsgId: email.xGmMsgId,
                xGmThrid: email.xGmThrid,
                folder: folderId,
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

            // Upsert threads
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

              db.upsertThreadFolder(numAccountId, threadId, folderId);
            }

            log.info(`MAIL_FETCH_EMAILS: Starred IMAP fallback fetched ${emails.length} emails, ${threadMap.size} threads`);

            // Re-query DB to get properly formatted results
            threads = db.getThreadsByFolder(numAccountId, folderId, limit, offset);
          }
        } catch (imapErr) {
          log.warn(`MAIL_FETCH_EMAILS: Starred IMAP fallback failed (returning empty):`, imapErr);
        }
      }

      if (threads.length === 0) {
        // Debug: check what's actually in the DB
        const rawDb = db.getDatabase();
        const threadCount = rawDb.exec('SELECT COUNT(*) FROM threads WHERE account_id = :accountId', { ':accountId': numAccountId });
        const tfCount = rawDb.exec('SELECT COUNT(*) FROM thread_folders WHERE account_id = :accountId', { ':accountId': numAccountId });
        const tfFolders = rawDb.exec('SELECT DISTINCT folder FROM thread_folders WHERE account_id = :accountId', { ':accountId': numAccountId });
        log.info(`DEBUG: total threads=${threadCount[0]?.values[0]?.[0]}, total thread_folders=${tfCount[0]?.values[0]?.[0]}, folders in thread_folders=${JSON.stringify(tfFolders[0]?.values)}`);
      }
      // Enrich threads with folders (from thread_folders) so list can show e.g. Draft/Sent/Deleted in Trash
      threads = attachThreadFolders(threads);
      // Enrich threads with label info
      threads = attachThreadLabels(threads);
      // Enrich threads with draft status
      const enrichedThreads = attachThreadDraftStatus(threads);
      return ipcSuccess(enrichedThreads);
    } catch (err) {
      log.error('Failed to fetch emails:', err);
      return ipcError('MAIL_FETCH_FAILED', 'Failed to fetch emails');
    }
  });

  // Fetch a full thread with all messages
  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_THREAD, async (_event, accountId: string, threadId: string, forceFromServer?: boolean) => {
    try {
      log.info(`Fetching thread ${threadId} for account ${accountId}`);
      const numAccountId = Number(accountId);
      const pendingOpService = PendingOpService.getInstance();

      // Get thread metadata
      const thread = db.getThreadById(numAccountId, threadId);
      if (!thread) {
        return ipcError('MAIL_THREAD_NOT_FOUND', 'Thread not found');
      }

      // Get all messages in this thread
      let messages = db.getEmailsByThreadId(numAccountId, threadId);
      log.info(`FETCH_THREAD: ${messages.length} messages from DB for thread ${threadId}`);

      // Filter out any messages that are pending queue confirmation (move/delete).
      // The optimistic DB update (moveEmailFolder) already reflects the correct local
      // state, so these messages should not appear in the response.
      const pendingIds = pendingOpService.getPendingForThread(numAccountId, threadId);
      if (pendingIds.size > 0) {
        messages = messages.filter((m) => !pendingIds.has(String(m['xGmMsgId'] ?? '')));
        log.info(`FETCH_THREAD: filtered ${pendingIds.size} pending message(s), ${messages.length} remaining for thread ${threadId}`);
      }

      // Fetch from IMAP when messages are missing bodies OR when the local cache has
      // been invalidated (0 messages after filtering). Guard: skip if a queue op is
      // still in-flight for this thread — the IMAP fetch would re-introduce the message
      // before the server-side delete/move has executed.
      const fetchKey = `${accountId}:${threadId}`;
      const threadFetchAttempted = pendingOpService.threadBodyFetchAttempted;
      const hasPending = pendingOpService.hasPendingForThread(numAccountId, threadId);

      if (hasPending) {
        // Block IMAP re-fetch while queue op is in-flight.
        // Mark as attempted so we don't loop; queue worker will clear this after completion.
        threadFetchAttempted.add(fetchKey);
        log.info(`FETCH_THREAD: blocking IMAP re-fetch for thread ${threadId} — queue op in-flight`);
      } else {
        const missingBodies = messages.filter(
          (m) => !m['htmlBody'] && !m['textBody']
        );
        const shouldFetch =
          forceFromServer === true ||
          ((messages.length === 0 || missingBodies.length > 0) && !threadFetchAttempted.has(fetchKey));
        if (shouldFetch) {
          threadFetchAttempted.add(fetchKey);
          log.info(`FETCH_THREAD: ${missingBodies.length}/${messages.length} messages missing bodies — fetching from IMAP`);

          try {
            const imapService = ImapService.getInstance();
            const fetchedMessages = await imapService.fetchThread(accountId, threadId);
            log.info(`FETCH_THREAD: IMAP returned ${fetchedMessages.length} messages for thread ${threadId}`);

            // Capture local thread message IDs before any upserts (for reconcile-to-server below)
            const localXGmMsgIds = new Set(
              db.getEmailsByThreadId(numAccountId, threadId).map((m) => String(m['xGmMsgId'] ?? '')).filter(Boolean)
            );
            const serverXGmMsgIds = new Set(fetchedMessages.map((m) => m.xGmMsgId));
            const staleXGmMsgIds = [...localXGmMsgIds].filter((id) => !serverXGmMsgIds.has(id));

            // Update DB with fetched bodies
            for (const fetched of fetchedMessages) {
              if (fetched.htmlBody || fetched.textBody) {
                db.upsertEmail({
                  accountId: numAccountId,
                  xGmMsgId: fetched.xGmMsgId,
                  xGmThrid: fetched.xGmThrid,
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
                  isDraft: fetched.isDraft,
                  snippet: fetched.snippet,
                  size: fetched.size,
                  hasAttachments: fetched.hasAttachments,
                  labels: fetched.labels,
                });
              }
            }

            // Reconcile thread to server: remove local messages no longer on server (e.g. draft deleted by Gmail after send)
            for (const xGmMsgId of staleXGmMsgIds) {
              db.removeEmailAndAssociations(numAccountId, xGmMsgId);
            }
            if (staleXGmMsgIds.length > 0) {
              log.info(`FETCH_THREAD: removed ${staleXGmMsgIds.length} stale message(s) from thread ${threadId} (no longer on server)`);
            }
            db.recomputeThreadMetadata(numAccountId, threadId);
            db.removeOrphanedThreads(numAccountId);

            // Re-fetch messages from DB with bodies (re-apply pending filter)
            messages = db.getEmailsByThreadId(numAccountId, threadId);
            if (pendingIds.size > 0) {
              messages = messages.filter((m) => !pendingIds.has(String(m['xGmMsgId'] ?? '')));
            }
          } catch (err) {
            log.warn(`Failed to fetch thread bodies from IMAP for ${threadId}:`, err);
          // Continue with what we have from DB
          }
        }
      }

      const response = buildThreadResponse(thread, messages, pendingIds, numAccountId);
      return ipcSuccess(response);
    } catch (err) {
      log.error('Failed to fetch thread:', err);
      return ipcError('MAIL_FETCH_THREAD_FAILED', 'Failed to fetch thread');
    }
  });

  // Get thread + messages from DB only (no IMAP). Used for instant display when opening a thread.
  ipcMain.handle(IPC_CHANNELS.MAIL_GET_THREAD_FROM_DB, async (_event, accountId: string, threadId: string) => {
    try {
      const numAccountId = Number(accountId);
      const thread = db.getThreadById(numAccountId, threadId);
      if (!thread) {
        return ipcError('MAIL_THREAD_NOT_FOUND', 'Thread not found');
      }
      let messages = db.getEmailsByThreadId(numAccountId, threadId);
      const pendingOpService = PendingOpService.getInstance();
      const pendingIds = pendingOpService.getPendingForThread(numAccountId, threadId);
      if (pendingIds.size > 0) {
        messages = messages.filter((m) => !pendingIds.has(String(m['xGmMsgId'] ?? '')));
      }
      const response = buildThreadResponse(thread, messages, pendingIds, numAccountId);
      return ipcSuccess(response);
    } catch (err) {
      log.error('Failed to get thread from DB:', err);
      return ipcError('MAIL_FETCH_THREAD_FAILED', 'Failed to get thread');
    }
  });

  // Send an email (via queue)
  ipcMain.handle(IPC_CHANNELS.MAIL_SEND, async (_event, accountId: string, message: {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    text?: string;
    html?: string;
    inReplyTo?: string;
    references?: string;
    attachments?: Array<{ filename: string; content: string; contentType: string }>;
    originalQueueId?: string;
    serverDraftXGmMsgId?: string;
  }) => {
    try {
      log.info(`Enqueuing send for account ${accountId}`);
      const queueService = MailQueueService.getInstance();

      const description = `Send to ${message.to}`;
      const queueId = queueService.enqueue(
        Number(accountId),
        'send',
        {
          to: message.to,
          cc: message.cc,
          bcc: message.bcc,
          subject: message.subject,
          text: message.text,
          html: message.html,
          inReplyTo: message.inReplyTo,
          references: message.references,
          attachments: message.attachments,
          originalQueueId: message.originalQueueId,
          serverDraftXGmMsgId: message.serverDraftXGmMsgId,
        },
        description,
      );

      return ipcSuccess({ queueId });
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to enqueue send';
      log.error('Failed to enqueue send:', err);
      return ipcError('MAIL_SEND_FAILED', errorMessage);
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
        const byMessageId = db.getEmailByXGmMsgId(numAccountId, id);
        if (byMessageId) {
          resolvedEmails.push(byMessageId);
          continue;
        }
        resolvedEmails.push(...db.getEmailsByThreadId(numAccountId, id));
      }

      const deduped = new Map<string, Record<string, unknown>>();
      for (const email of resolvedEmails) {
        const xGmMsgId = String(email['xGmMsgId'] || '');
        if (xGmMsgId) {
          deduped.set(xGmMsgId, email);
        }
      }

      // Handle orphan threads (zero emails) — clean up immediately
      if (deduped.size === 0 && messageIds.length === 1 && sourceFolder) {
        const orphanThreadId = messageIds[0];
        const asEmail = db.getEmailByXGmMsgId(numAccountId, orphanThreadId);
        if (!asEmail) {
          const threadEmails = db.getEmailsByThreadId(numAccountId, orphanThreadId);
          if (threadEmails.length === 0) {
            const internalThreadId = db.getThreadInternalId(numAccountId, orphanThreadId);
            if (internalThreadId != null) {
              db.removeThreadFolderAssociation(numAccountId, orphanThreadId, sourceFolder);
              log.info(`MAIL_MOVE: Removed orphan thread ${orphanThreadId} from ${sourceFolder}`);
            }
            return ipcSuccess(null);
          }
        }
      }

      const resolvedEmailsMeta: Array<{ xGmMsgId: string; xGmThrid: string }> = [];
      const sourceFolderSet = new Set<string>();

      for (const email of deduped.values()) {
        const xGmMsgId = String(email['xGmMsgId'] || '');
        const xGmThrid = String(email['xGmThrid'] || '');
        const folders = db.getFoldersForEmail(numAccountId, xGmMsgId);

        resolvedEmailsMeta.push({ xGmMsgId, xGmThrid });

        if (sourceFolder) {
          if (folders.includes(sourceFolder)) {
            sourceFolderSet.add(sourceFolder);
          }
        } else {
          for (const existingFolder of folders) {
            if (existingFolder !== targetFolder) {
              sourceFolderSet.add(existingFolder);
            }
          }
        }
      }

      // Optimistic local DB update for folder associations.
      const sourceFolders = Array.from(sourceFolderSet);
      for (const srcFolder of sourceFolders) {
        if (srcFolder === targetFolder) continue;

        for (const email of deduped.values()) {
          const xGmMsgId = String(email['xGmMsgId'] || '');
          const xGmThrid = String(email['xGmThrid'] || '');
          if (!xGmMsgId) continue;

          // Check if this email is actually in this source folder
          const inFolder = db.getFoldersForEmail(numAccountId, xGmMsgId).includes(srcFolder);
          if (!inFolder) continue;

          db.moveEmailFolder(numAccountId, xGmMsgId, srcFolder, targetFolder, null);

          if (xGmThrid) {
            const internalThreadId = db.getThreadInternalId(numAccountId, xGmThrid);
            if (internalThreadId != null) {
              if (!db.threadHasEmailsInFolder(numAccountId, xGmThrid, srcFolder)) {
                db.moveThreadFolder(numAccountId, xGmThrid, srcFolder, targetFolder);
              } else {
                db.upsertThreadFolder(numAccountId, xGmThrid, targetFolder);
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
          xGmMsgIds: Array.from(deduped.keys()),
          sourceFolder,
          sourceFolders,
          targetFolder,
          emailMeta: resolvedEmailsMeta,
        },
        description,
      );

      // Register pending operations so FETCH_THREAD blocks IMAP re-fetch until the
      // queue worker confirms the server-side move. Group by thread.
      const pendingOpService = PendingOpService.getInstance();
      const byThread = new Map<string, string[]>();
      for (const { xGmMsgId, xGmThrid } of resolvedEmailsMeta) {
        if (!xGmThrid) {
          continue;
        }
        if (!byThread.has(xGmThrid)) {
          byThread.set(xGmThrid, []);
        }
        byThread.get(xGmThrid)!.push(xGmMsgId);
      }
      for (const [xGmThrid, messageIdList] of byThread) {
        pendingOpService.register(numAccountId, xGmThrid, messageIdList);
      }

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

      // Resolve emails for optimistic DB update and queue payload
      const flagMap: Record<string, { isRead?: boolean; isStarred?: boolean; isImportant?: boolean }> = {
        read: { isRead: value },
        starred: { isStarred: value },
        important: { isImportant: value },
      };
      const resolvedEmails: Array<Record<string, unknown>> = [];
      for (const id of messageIds) {
        const byMessageId = db.getEmailByXGmMsgId(numAccountId, id);
        if (byMessageId) {
          resolvedEmails.push(byMessageId);
          continue;
        }
        resolvedEmails.push(...db.getEmailsByThreadId(numAccountId, id));
      }

      const deduped = new Map<string, Record<string, unknown>>();
      for (const email of resolvedEmails) {
        const xGmMsgId = String(email['xGmMsgId'] || '');
        if (xGmMsgId) {
          deduped.set(xGmMsgId, email);
        }
      }

      // Optimistic local DB update: set flags immediately for responsive UI
      const dbFlags = flagMap[flag];
      if (dbFlags) {
        for (const email of deduped.values()) {
          db.updateEmailFlags(numAccountId, String(email['xGmMsgId']), dbFlags);
        }
      }

      // Also update the threads table so that fetchThread returns correct flag state
      const threadFlagMap: Record<string, { isRead?: boolean; isStarred?: boolean }> = {
        read: { isRead: value },
        starred: { isStarred: value },
      };
      const threadFlags = threadFlagMap[flag];
      if (threadFlags) {
        const firstEmail = deduped.values().next().value;
        const flagThreadId = firstEmail ? String(firstEmail['xGmThrid'] || '') : '';
        if (flagThreadId) {
          db.updateThreadFlags(numAccountId, flagThreadId, threadFlags);
        }
      }

      // Enqueue the IMAP flag update via the queue
      const description = `Flag: ${flag}=${value} on ${messageIds.length} email(s)`;
      const queueId = queueService.enqueue(
        numAccountId,
        'flag',
        { xGmMsgIds: Array.from(deduped.keys()), flag, value },
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
        const byMessageId = db.getEmailByXGmMsgId(numAccountId, id);
        if (byMessageId) {
          resolvedEmails.push(byMessageId);
          continue;
        }
        resolvedEmails.push(...db.getEmailsByThreadId(numAccountId, id));
      }

      const deduped = new Map<string, Record<string, unknown>>();
      for (const email of resolvedEmails) {
        const xGmMsgId = String(email['xGmMsgId'] || '');
        if (xGmMsgId) {
          deduped.set(xGmMsgId, email);
        }
      }

      const resolvedEmailsMeta: Array<{ xGmMsgId: string; xGmThrid: string }> = [];

      for (const email of deduped.values()) {
        const xGmMsgId = String(email['xGmMsgId'] || '');
        const xGmThrid = String(email['xGmThrid'] || '');
        resolvedEmailsMeta.push({ xGmMsgId, xGmThrid });
      }

      // Optimistic DB update
      if (isPermanent) {
        for (const email of deduped.values()) {
          db.removeEmailAndAssociations(numAccountId, String(email['xGmMsgId']));
        }
      } else {
        for (const email of deduped.values()) {
          const xGmMsgId = String(email['xGmMsgId'] || '');
          const xGmThrid = String(email['xGmThrid'] || '');
          if (!xGmMsgId) continue;

          db.moveEmailFolder(numAccountId, xGmMsgId, folder, '[Gmail]/Trash', null);

          if (xGmThrid) {
            const internalThreadId = db.getThreadInternalId(numAccountId, xGmThrid);
            if (internalThreadId != null) {
              if (!db.threadHasEmailsInFolder(numAccountId, xGmThrid, folder)) {
                db.moveThreadFolder(numAccountId, xGmThrid, folder, '[Gmail]/Trash');
              } else {
                db.upsertThreadFolder(numAccountId, xGmThrid, '[Gmail]/Trash');
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
          xGmMsgIds: Array.from(deduped.keys()),
          folder,
          emailMeta: resolvedEmailsMeta,
          permanent: isPermanent,
        },
        description,
      );

      // Register pending operations so FETCH_THREAD blocks IMAP re-fetch until the
      // queue worker confirms the server-side delete. Group by thread.
      // For permanent deletes the emails are already removed from DB; only register for
      // soft deletes (moved to Trash) where the email row still exists in the DB.
      if (!isPermanent) {
        const pendingOpService = PendingOpService.getInstance();
        const byThread = new Map<string, string[]>();
        for (const { xGmMsgId, xGmThrid } of resolvedEmailsMeta) {
          if (!xGmThrid) {
            continue;
          }
          if (!byThread.has(xGmThrid)) {
            byThread.set(xGmThrid, []);
          }
          byThread.get(xGmThrid)!.push(xGmMsgId);
        }
        for (const [xGmThrid, messageIdList] of byThread) {
          pendingOpService.register(numAccountId, xGmThrid, messageIdList);
        }
      }

      return ipcSuccess({ queueId });
    } catch (err) {
      log.error('Failed to enqueue delete:', err);
      return ipcError('MAIL_DELETE_FAILED', 'Failed to delete emails');
    }
  });

  // Search emails locally — returns thread-grouped results across all folders
  ipcMain.handle(IPC_CHANNELS.MAIL_SEARCH, async (_event, accountId: string, queryInput: string | string[]) => {
    try {
      if (!accountId || isNaN(Number(accountId))) {
        return ipcError('MAIL_SEARCH_INVALID_INPUT', 'Valid account ID is required');
      }

      const queries = normalizeSearchQueries(queryInput);
      if (queries.length === 0) {
        return ipcError('MAIL_SEARCH_INVALID_INPUT', 'At least one search query is required');
      }
      for (const query of queries) {
        if (query.length > 2048) {
          return ipcError('MAIL_SEARCH_INVALID_INPUT', 'Query too long (max 2048 characters)');
        }
      }

      const numAccountId = Number(accountId);
      log.info(`[MAIL_SEARCH] Searching ${queries.length} query variant(s) for account ${accountId}`);

      const rawResults = queries.length === 1
        ? db.searchEmails(numAccountId, queries[0])
        : db.searchEmailsMulti(numAccountId, queries);
      let results = attachThreadFolders(rawResults);
      results = attachThreadDraftStatus(results);

      log.info(`[MAIL_SEARCH] Found ${results.length} merged thread result(s) for account ${accountId}`);
      return ipcSuccess(results);
    } catch (err) {
      log.error('[MAIL_SEARCH] Failed to search:', err);
      return ipcError('MAIL_SEARCH_FAILED', 'Failed to search emails');
    }
  });

  // Search emails via IMAP using Gmail X-GM-RAW — upserts results to DB, returns thread-grouped results
  ipcMain.handle(IPC_CHANNELS.MAIL_SEARCH_IMAP, async (_event, accountId: string, queryInput: string | string[]) => {
    try {
      if (!accountId || isNaN(Number(accountId))) {
        return ipcError('MAIL_SEARCH_IMAP_INVALID_INPUT', 'Valid account ID is required');
      }

      const queries = normalizeSearchQueries(queryInput);
      if (queries.length === 0) {
        return ipcError('MAIL_SEARCH_IMAP_INVALID_INPUT', 'At least one search query is required');
      }
      for (const query of queries) {
        if (query.length > 2048) {
          return ipcError('MAIL_SEARCH_IMAP_INVALID_INPUT', 'Query too long (max 2048 characters)');
        }
      }

      const combinedQuery = queries.length === 1
        ? queries[0]
        : queries.map((query) => `(${query})`).join(' OR ');

      const numAccountId = Number(accountId);
      const imapService = ImapService.getInstance();
      const lockManager = FolderLockManager.getInstance();
      const folder = '[Gmail]/All Mail';

      log.info(`[MAIL_SEARCH_IMAP] Searching ${queries.length} query variant(s) via IMAP for account ${accountId}`);

      let emails: Awaited<ReturnType<typeof imapService.searchEmails>>;
      const release = await lockManager.acquire(folder, accountId);
      try {
        const searchPromise = imapService.searchEmails(accountId, combinedQuery, 100);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('IMAP search timed out')), 30_000)
        );
        emails = await Promise.race([searchPromise, timeoutPromise]);
      } finally {
        release();
      }

      if (emails.length === 0) {
        log.info(`[MAIL_SEARCH_IMAP] No IMAP results for ${queries.length} query variant(s)`);
        return ipcSuccess({ threads: [], resultCount: 0 });
      }

      const threadMap = new Map<string, typeof emails>();
      for (const email of emails) {
        const threadId = email.xGmThrid || email.xGmMsgId;
        if (!threadMap.has(threadId)) {
          threadMap.set(threadId, []);
        }
        threadMap.get(threadId)!.push(email);
      }

      const rawDb = db.getDatabase();
      rawDb.run('BEGIN');
      try {
        for (const email of emails) {
          db.upsertEmail({
            accountId: numAccountId,
            xGmMsgId: email.xGmMsgId,
            xGmThrid: email.xGmThrid,
            folder: folder,
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

        for (const [threadId, threadEmails] of threadMap) {
          const uniqueEmails = [...new Map(threadEmails.map((email) => [email.xGmMsgId, email])).values()];
          const latest = uniqueEmails.reduce((a, b) =>
            new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
          );
          const participants = [...new Set(uniqueEmails.map((email) => email.fromAddress))].join(', ');
          const allRead = uniqueEmails.every((email) => email.isRead);
          const anyStarred = uniqueEmails.some((email) => email.isStarred);

          const existingThread = db.getThreadById(numAccountId, threadId);
          const existingMessageCount = (existingThread?.['messageCount'] as number) || 0;

          if (!existingThread || uniqueEmails.length >= existingMessageCount) {
            db.upsertThread({
              accountId: numAccountId,
              xGmThrid: threadId,
              subject: latest.subject,
              lastMessageDate: latest.date,
              participants,
              messageCount: Math.max(uniqueEmails.length, existingMessageCount),
              snippet: latest.snippet,
              isRead: allRead,
              isStarred: anyStarred,
            });
            db.upsertThreadFolder(numAccountId, threadId, folder);
          } else {
            db.upsertThreadFolder(numAccountId, threadId, folder);
          }
        }

        rawDb.run('COMMIT');
      } catch (upsertErr) {
        rawDb.run('ROLLBACK');
        throw upsertErr;
      }

      const threads: Array<Record<string, unknown>> = [];
      for (const [threadId, threadEmails] of threadMap) {
        const uniqueEmails = [...new Map(threadEmails.map((email) => [email.xGmMsgId, email])).values()];
        const latest = uniqueEmails.reduce((a, b) =>
          new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
        );
        const participants = [...new Set(uniqueEmails.map((email) => email.fromAddress))].join(', ');
        const allRead = uniqueEmails.every((email) => email.isRead);
        const anyStarred = uniqueEmails.some((email) => email.isStarred);

        const existingThread = db.getThreadById(numAccountId, threadId);

        threads.push({
          id: existingThread?.['id'] || 0,
          accountId: numAccountId,
          xGmThrid: threadId,
          subject: (existingThread?.['subject'] as string) || latest.subject,
          lastMessageDate: latest.date,
          participants: (existingThread?.['participants'] as string) || participants,
          messageCount: Math.max(uniqueEmails.length, (existingThread?.['messageCount'] as number) || 0),
          snippet: latest.snippet,
          folder: 'search',
          isRead: allRead,
          isStarred: anyStarred,
        });
      }

      threads.sort((a, b) =>
        new Date(b['lastMessageDate'] as string).getTime() - new Date(a['lastMessageDate'] as string).getTime()
      );

      let threadsWithFolders = attachThreadFolders(threads);
      threadsWithFolders = attachThreadDraftStatus(threadsWithFolders);
      log.info(
        `[MAIL_SEARCH_IMAP] IMAP search found ${emails.length} emails, ${threadMap.size} threads, returning ${threadsWithFolders.length} thread results`
      );
      return ipcSuccess({ threads: threadsWithFolders, resultCount: threadsWithFolders.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'IMAP search failed';
      log.error('[MAIL_SEARCH_IMAP] Failed:', err);
      if (message.includes('timed out') || message.includes('abort')) {
        return ipcError('MAIL_SEARCH_IMAP_TIMEOUT', 'IMAP search timed out');
      }
      return ipcError('MAIL_SEARCH_IMAP_FAILED', message);
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

  // Fetch older emails from IMAP server (scroll-to-load)
  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_OLDER, async (_event, accountId: string, folderId: string, beforeDate: string, limit: number) => {
    try {
      log.info(`Fetching older emails for account ${accountId}, folder ${folderId}, before ${beforeDate}, limit ${limit}`);
      const numAccountId = Number(accountId);

      // Handle virtual label folder: label::<id> — local-only pagination
      if (folderId.startsWith('label::')) {
        const labelId = Number(folderId.substring(7));
        if (!Number.isFinite(labelId) || labelId <= 0) {
          return ipcError('MAIL_INVALID_FOLDER', `Invalid label folder ID: ${folderId}`);
        }
        const parsedLabelDate = new Date(beforeDate);
        if (isNaN(parsedLabelDate.getTime())) {
          return ipcError('INVALID_DATE', `Invalid beforeDate: ${beforeDate}`);
        }
        const sanitizedLabelLimit = Math.max(1, Number(limit) || 50);
        let threads = db.getThreadsByUserLabelBeforeDate(numAccountId, labelId, beforeDate, sanitizedLabelLimit);
        threads = attachThreadFolders(threads);
        threads = attachThreadLabels(threads);
        threads = attachThreadDraftStatus(threads);
        return ipcSuccess({ threads, hasMore: threads.length === sanitizedLabelLimit });
      }

      const imapService = ImapService.getInstance();

      // Validate date
      const parsedDate = new Date(beforeDate);
      if (isNaN(parsedDate.getTime())) {
        return ipcError('INVALID_DATE', `Invalid beforeDate: ${beforeDate}`);
      }

      const sanitizedLimit = Math.max(1, Number(limit) || 50);

      const { emails, hasMore } = await imapService.fetchOlderEmails(
        accountId,
        folderId,
        parsedDate,
        sanitizedLimit
      );

      if (emails.length === 0) {
        log.info(`MAIL_FETCH_OLDER: no older emails found for ${folderId}`);
        return ipcSuccess({ threads: [], hasMore: false });
      }

      // Upsert fetched emails into DB (same pattern as SyncService.syncAccount)
      const threadMap = new Map<string, typeof emails>();
      for (const email of emails) {
        const threadId = email.xGmThrid || email.xGmMsgId;
        if (!threadMap.has(threadId)) {
          threadMap.set(threadId, []);
        }
        threadMap.get(threadId)!.push(email);
      }

      // Store emails and contacts
      for (const email of emails) {
        db.upsertEmail({
          accountId: numAccountId,
          xGmMsgId: email.xGmMsgId,
          xGmThrid: email.xGmThrid,
          folder: folderId,
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

      // Upsert threads (dedupe by xGmMsgId)
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

        db.upsertThreadFolder(numAccountId, threadId, folderId);
      }

      // Query DB directly for threads before the requested date (proper SQL pagination)
      let threads = db.getThreadsByFolderBeforeDate(
        numAccountId,
        folderId,
        beforeDate,
        sanitizedLimit
      );
      threads = attachThreadDraftStatus(threads);

      // Cursor for the next older-page fetch should be based on fetched email dates,
      // not returned thread dates. A fetch can return zero "older threads" when all
      // fetched emails belong to already-visible threads.
      const oldestEmailTs = emails.reduce((minTs, email) => {
        const ts = new Date(email.date).getTime();
        if (!Number.isFinite(ts)) return minTs;
        return ts < minTs ? ts : minTs;
      }, Number.POSITIVE_INFINITY);

      let nextBeforeDate: string | null = null;
      if (Number.isFinite(oldestEmailTs)) {
        nextBeforeDate = new Date(oldestEmailTs).toISOString();
      }

      // IMAP BEFORE is day-granular. If the cursor does not move older by timestamp,
      // force one-day backoff to avoid refetching the same UID window forever.
      if (!nextBeforeDate || new Date(nextBeforeDate).getTime() >= parsedDate.getTime()) {
        const fallback = new Date(parsedDate);
        fallback.setDate(fallback.getDate() - 1);
        nextBeforeDate = fallback.toISOString();
      }

      log.info(
        `MAIL_FETCH_OLDER: fetched ${emails.length} emails, upserted ${threadMap.size} threads, ` +
        `returning ${threads.length} threads, hasMore=${hasMore}, nextBeforeDate=${nextBeforeDate}`
      );
      return ipcSuccess({ threads, hasMore, nextBeforeDate });
    } catch (err) {
      log.error('Failed to fetch older emails:', err);
      return ipcError('MAIL_FETCH_OLDER_FAILED', 'Failed to fetch older emails from server');
    }
  });

  // Get folder list for an account. Unread counts use local unread *thread* count so they match Gmail (conversations, not messages).
  ipcMain.handle(IPC_CHANNELS.MAIL_GET_FOLDERS, async (_event, accountId: string) => {
    try {
      log.info(`Getting folders for account ${accountId}`);
      const numAccountId = Number(accountId);
      const labels = db.getLabelsByAccount(numAccountId);
      const unreadByFolder = db.getUnreadThreadCountsByFolder(numAccountId);
      const labelsWithThreadCounts = labels
        .filter((row) => (row.gmailLabelId as string) !== '[Gmail]/All Mail')
        .map((row) => ({
          ...row,
          unreadCount: unreadByFolder[row.gmailLabelId as string] ?? 0,
        }));

      // Append user-defined filter label folders as virtual entries
      const userLabels = db.getUserLabels(numAccountId);
      const filterLabelFolders = userLabels.map((label) => ({
        id: label.id,
        accountId: numAccountId,
        gmailLabelId: `label::${label.id}`,
        name: label.name,
        type: 'filter-label',
        color: label.color,
        unreadCount: label.unreadCount,
        totalCount: 0,
        icon: 'sell',
      }));

      return ipcSuccess([...labelsWithThreadCounts, ...filterLabelFolders]);
    } catch (err) {
      log.error('Failed to get folders:', err);
      return ipcError('MAIL_GET_FOLDERS_FAILED', 'Failed to get folders');
    }
  });
}
