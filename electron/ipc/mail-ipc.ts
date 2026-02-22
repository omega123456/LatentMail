import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { ALL_MAIL_PATH } from '../services/sync-service';
import { MailQueueService } from '../services/mail-queue-service';
import { SyncQueueBridge } from '../services/sync-queue-bridge';
import { FolderLockManager } from '../services/folder-lock-manager';
import { PendingOpService } from '../services/pending-op-service';

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
   * Get threads for a folder with list-row enrichment (folders, hasDraft).
   * When threadId is provided, returns at most one thread (same shape as list items).
   * Used by MAIL_FETCH_EMAILS and by MAIL_GET_THREAD_FROM_DB when folderId is supplied.
   */
  function getEnrichedThreadsForFolder(
    numAccountId: number,
    folderId: string,
    limit: number,
    offset: number,
    threadId?: string
  ): Array<Record<string, unknown>> {
    const effectiveLimit = threadId != null && threadId !== '' ? 1 : limit;
    const effectiveOffset = threadId != null && threadId !== '' ? 0 : offset;
    let threads = db.getThreadsByFolder(numAccountId, folderId, effectiveLimit, effectiveOffset, threadId);
    threads = attachThreadFolders(threads);
    return attachThreadDraftStatus(threads);
  }

  /**
   * Enrich threads with hasDraft status.
   * For each thread, checks if any constituent email has is_draft=1.
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

      const threads = getEnrichedThreadsForFolder(numAccountId, folderId, limit, offset);
      log.info(`MAIL_FETCH_EMAILS: account=${accountId} folder=${folderId} returned ${threads.length} threads`);

      if (threads.length === 0) {
        // Debug: check what's actually in the DB
        const rawDb = db.getDatabase();
        const threadCount = rawDb.exec('SELECT COUNT(*) FROM threads WHERE account_id = :accountId', { ':accountId': numAccountId });
        const tfCount = rawDb.exec('SELECT COUNT(*) FROM thread_folders WHERE account_id = :accountId', { ':accountId': numAccountId });
        const tfFolders = rawDb.exec('SELECT DISTINCT folder FROM thread_folders WHERE account_id = :accountId', { ':accountId': numAccountId });
        log.info(`DEBUG: total threads=${threadCount[0]?.values[0]?.[0]}, total thread_folders=${tfCount[0]?.values[0]?.[0]}, folders in thread_folders=${JSON.stringify(tfFolders[0]?.values)}`);
      }
      return ipcSuccess(threads);
    } catch (err) {
      log.error('Failed to fetch emails:', err);
      return ipcError('MAIL_FETCH_FAILED', 'Failed to fetch emails');
    }
  });

  // Fetch a full thread with all messages.
  // Returns DB-only data immediately. If bodies are missing, enqueues a sync-thread
  // item that fetches from IMAP asynchronously and emits MAIL_THREAD_REFRESH when done.
  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_THREAD, async (_event, accountId: string, threadId: string, forceFromServer?: boolean) => {
    try {
      log.info(`Fetching thread ${threadId} for account ${accountId}`);
      const numAccountId = Number(accountId);
      const pendingOpService = PendingOpService.getInstance();

      // Get thread metadata from DB
      const thread = db.getThreadById(numAccountId, threadId);
      if (!thread) {
        return ipcError('MAIL_THREAD_NOT_FOUND', 'Thread not found');
      }

      // Get all messages in this thread from DB
      let messages = db.getEmailsByThreadId(numAccountId, threadId);
      log.info(`FETCH_THREAD: ${messages.length} messages from DB for thread ${threadId}`);

      // Filter out messages that are pending queue confirmation (move/delete).
      // The optimistic DB update already reflects the correct local state.
      const pendingIds = pendingOpService.getPendingForThread(numAccountId, threadId);
      if (pendingIds.size > 0) {
        messages = messages.filter((m) => !pendingIds.has(String(m['xGmMsgId'] ?? '')));
        log.info(`FETCH_THREAD: filtered ${pendingIds.size} pending message(s), ${messages.length} remaining for thread ${threadId}`);
      }

      // Enqueue async IMAP fetch if bodies are missing and no pending ops block it.
      // Dedup in the queue ensures clicking the same thread twice only results in one fetch.
      // The sync-thread queue worker will upsert bodies and emit MAIL_THREAD_REFRESH
      // when done so the renderer reloads automatically.
      const hasPending = pendingOpService.hasPendingForThread(numAccountId, threadId);
      if (!hasPending) {
        const missingBodies = messages.filter((m) => !m['htmlBody'] && !m['textBody']);
        const needsFetch = forceFromServer === true || messages.length === 0 || missingBodies.length > 0;
        if (needsFetch) {
          log.info(`FETCH_THREAD: enqueueing sync-thread for ${threadId} (${missingBodies.length}/${messages.length} missing bodies, force=${forceFromServer})`);
          SyncQueueBridge.getInstance().enqueueThreadSync(numAccountId, threadId, forceFromServer === true);
        }
      } else {
        log.info(`FETCH_THREAD: skipping sync-thread enqueue for ${threadId} — queue op in-flight`);
      }

      // Return DB-only data immediately (renderer will receive MAIL_THREAD_REFRESH when bodies arrive).
      const response = buildThreadResponse(thread, messages, pendingIds, numAccountId);
      return ipcSuccess(response);
    } catch (err) {
      log.error('Failed to fetch thread:', err);
      return ipcError('MAIL_FETCH_THREAD_FAILED', 'Failed to fetch thread');
    }
  });

  // Get thread + messages from DB only (no IMAP). Used for instant display when opening a thread.
  ipcMain.handle(IPC_CHANNELS.MAIL_GET_THREAD_FROM_DB, async (_event, accountId: string, threadId: string, folderId?: string) => {
    try {
      const numAccountId = Number(accountId);
      const pendingOpService = PendingOpService.getInstance();
      const pendingIds = pendingOpService.getPendingForThread(numAccountId, threadId);

      // When folderId is provided (e.g. for reconcile), use same list-row shape as folder fetch.
      if (folderId != null && folderId !== '') {
        const enrichedThreads = getEnrichedThreadsForFolder(numAccountId, folderId, 1, 0, threadId);
        if (enrichedThreads.length > 0) {
          const enrichedThread = enrichedThreads[0];
          let messages = db.getEmailsByThreadId(numAccountId, threadId);
          if (pendingIds.size > 0) {
            messages = messages.filter((m) => !pendingIds.has(String(m['xGmMsgId'] ?? '')));
          }
          const withMessages = buildThreadResponse(enrichedThread, messages, pendingIds, numAccountId);
          // Keep list-row fields from enriched thread; use buildThreadResponse only for messages array.
          return ipcSuccess({ ...enrichedThread, messages: withMessages['messages'] });
        }
      }

      // No folderId or thread not in folder: use thread-by-id + buildThreadResponse.
      const thread = db.getThreadById(numAccountId, threadId);
      if (!thread) {
        return ipcError('MAIL_THREAD_NOT_FOUND', 'Thread not found');
      }
      let messages = db.getEmailsByThreadId(numAccountId, threadId);
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
      const folder = ALL_MAIL_PATH;

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
            messageId: email.messageId,
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
            if (folder !== ALL_MAIL_PATH) {
              db.upsertThreadFolder(numAccountId, threadId, folder);
            }
          } else {
            if (folder !== ALL_MAIL_PATH) {
              db.upsertThreadFolder(numAccountId, threadId, folder);
            }
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

  // Trigger manual sync for an account — enqueues per-folder items via the queue bridge.
  // Returns immediately; progress is visible via the queue status indicator.
  ipcMain.handle(IPC_CHANNELS.MAIL_SYNC_ACCOUNT, async (_event, accountId: string) => {
    try {
      log.info(`Manual sync triggered for account ${accountId}`);
      const bridge = SyncQueueBridge.getInstance();
      await bridge.enqueueSyncForAccount(Number(accountId), false);
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
          messageId: email.messageId,
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
        .filter((row) => (row.gmailLabelId as string) !== ALL_MAIL_PATH)
        .map((row) => ({
          ...row,
          unreadCount: unreadByFolder[row.gmailLabelId as string] ?? 0,
        }));

      return ipcSuccess(labelsWithThreadCounts);
    } catch (err) {
      log.error('Failed to get folders:', err);
      return ipcError('MAIL_GET_FOLDERS_FAILED', 'Failed to get folders');
    }
  });
}
