import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError, IpcResponse } from './ipc-channels';

const log = LoggerService.getInstance();
import { DatabaseService } from '../services/database-service';
import { ImapService } from '../services/imap-service';
import { ALL_MAIL_PATH, EXCLUDED_FOLDER_PATHS, SyncService } from '../services/sync-service';
import { MailQueueService } from '../services/mail-queue-service';
import { SyncQueueBridge } from '../services/sync-queue-bridge';
import { FolderLockManager } from '../services/folder-lock-manager';
import { PendingOpService } from '../services/pending-op-service';
import { formatParticipantList } from '../utils/format-participant';

export function registerMailIpcHandlers(): void {
  const db = DatabaseService.getInstance();

  /**
   * Build thread response object (thread metadata + messages with folders + attachments).
   * Shared by MAIL_FETCH_THREAD and MAIL_GET_THREAD_FROM_DB.
   */
  function buildThreadResponse(
    thread: Record<string, unknown>,
    messages: Array<Record<string, unknown>>,
    pendingIds: Set<string>,
    numAccountId: number
  ): Record<string, unknown> {
    // Batch-fetch attachment metadata for all messages in the thread
    const xGmMsgIds = messages
      .map((m) => String(m['xGmMsgId'] ?? ''))
      .filter((id) => id.length > 0);
    const attachmentMap = xGmMsgIds.length > 0
      ? db.getAttachmentsForEmails(numAccountId, xGmMsgIds)
      : new Map<string, unknown[]>();

    const messagesWithFolders: Array<Record<string, unknown>> = messages.map((m) => {
      const xGmMsgId = String(m['xGmMsgId'] ?? '');
      const folders = xGmMsgId ? db.getFoldersForEmail(numAccountId, xGmMsgId) : [];
      const attachments = xGmMsgId ? (attachmentMap.get(xGmMsgId) ?? []) : [];
      return { ...m, folders, attachments };
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
      const participants = formatParticipantList(
        messagesWithFolders.map((message) => ({
          fromAddress: String(message['fromAddress'] ?? ''),
          fromName: message['fromName'] != null ? String(message['fromName']) : undefined,
        }))
      );

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

  /**
   * Enrich threads with user label data.
   * Batch-queries email_folders → labels (type='user') for all supplied threads.
   * Attaches a `labels` array to each thread (empty array when no labels).
   */
  const attachThreadLabels = (threads: Array<Record<string, unknown>>, accountId: number): Array<Record<string, unknown>> => {
    const xGmThrids = threads
      .map((thread) => {
        const rawId = thread['xGmThrid'];
        return typeof rawId === 'string' ? rawId : null;
      })
      .filter((identifier): identifier is string => identifier != null && identifier.length > 0);

    if (xGmThrids.length === 0) {
      return threads.map((thread) => ({ ...thread, labels: [] }));
    }

    const labelMap = db.getLabelsForThreadBatch(accountId, xGmThrids);

    return threads.map((thread) => {
      const xGmThrid = typeof thread['xGmThrid'] === 'string' ? thread['xGmThrid'] : '';
      const labels = xGmThrid ? (labelMap.get(xGmThrid) ?? []) : [];
      return { ...thread, labels };
    });
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
    threads = attachThreadDraftStatus(threads, folderId, numAccountId);
    return attachThreadLabels(threads, numAccountId);
  }

  /**
   * Enrich threads with hasDraft status.
   * For each thread, checks if any constituent email has is_draft=1.
   * Excludes trashed drafts unless the current folder is Trash.
   */
  const attachThreadDraftStatus = (
    threads: Array<Record<string, unknown>>,
    folderId: string,
    numAccountId: number
  ): Array<Record<string, unknown>> => {
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

    const draftThreadIds = db.getThreadIdsWithDrafts(numAccountId, threadIds, folderId);
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
        const threadCountRow = rawDb.prepare('SELECT COUNT(*) AS count FROM threads WHERE account_id = :accountId').get({ accountId: numAccountId }) as Record<string, unknown> | undefined;
        const tfCountRow = rawDb.prepare('SELECT COUNT(*) AS count FROM thread_folders WHERE account_id = :accountId').get({ accountId: numAccountId }) as Record<string, unknown> | undefined;
        const tfFolders = rawDb.prepare('SELECT DISTINCT folder FROM thread_folders WHERE account_id = :accountId').all({ accountId: numAccountId }) as Array<Record<string, unknown>>;
        log.info(`DEBUG: total threads=${threadCountRow?.['count']}, total thread_folders=${tfCountRow?.['count']}, folders in thread_folders=${JSON.stringify(tfFolders.map((row) => row['folder']))}`);
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

      // Filter deduped to only emails present in sourceFolder (folder-scoped operation).
      // Emails in other folders (e.g., already in Trash) are excluded so we do not
      // create phantom folder associations for them.
      if (sourceFolder) {
        const keysToRemove: string[] = [];
        for (const [xGmMsgId] of deduped) {
          const folders = db.getFoldersForEmail(numAccountId, xGmMsgId);
          if (!folders.includes(sourceFolder)) {
            keysToRemove.push(xGmMsgId);
          }
        }
        if (keysToRemove.length > 0) {
          log.debug(`MAIL_MOVE: Filtered out ${keysToRemove.length} email(s) not in sourceFolder ${sourceFolder}: ${keysToRemove.join(', ')}`);
          for (const key of keysToRemove) {
            deduped.delete(key);
          }
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

  // Delete messages (via queue) — always a soft-delete (move to Trash).
  // Returns no-op success when folder is already the trash folder since there
  // is no meaningful action to take (Trash items cannot be permanently deleted
  // through this application).
  ipcMain.handle(IPC_CHANNELS.MAIL_DELETE, async (_event, accountId: string, messageIds: string[], folder: string) => {
    try {
      log.info(`Enqueuing delete of ${messageIds.length} messages from ${folder} for account ${accountId}`);
      const numAccountId = Number(accountId);
      const queueService = MailQueueService.getInstance();
      const trashFolder = db.getTrashFolder(numAccountId);

      // No-op: deleting from Trash is not supported — return early with success.
      if (folder === trashFolder) {
        log.info(`MAIL_DELETE: folder is ${trashFolder} — no-op (permanent delete not supported)`);
        return ipcSuccess({ queueId: null });
      }

      const resolvedEmails: Array<Record<string, unknown>> = [];
      for (const id of messageIds) {
        const byMessageId = db.getEmailByXGmMsgId(numAccountId, id);
        if (byMessageId) {
          resolvedEmails.push(byMessageId);
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

      // Filter deduped to only emails present in folder (folder-scoped operation).
      // Emails in other folders (e.g., already in Trash) are excluded so we do not
      // create phantom Trash associations for messages that were never in this folder.
      {
        const keysToRemove: string[] = [];
        for (const [xGmMsgId] of deduped) {
          const folders = db.getFoldersForEmail(numAccountId, xGmMsgId);
          if (!folders.includes(folder)) {
            keysToRemove.push(xGmMsgId);
          }
        }
        if (keysToRemove.length > 0) {
          log.debug(`MAIL_DELETE: Filtered out ${keysToRemove.length} email(s) not in folder ${folder}: ${keysToRemove.join(', ')}`);
          for (const key of keysToRemove) {
            deduped.delete(key);
          }
        }
      }

      // If all emails were filtered out, there is nothing to delete from this folder — no-op.
      if (deduped.size === 0) {
        log.info(`MAIL_DELETE: No emails in folder ${folder} after filtering — returning no-op success`);
        return ipcSuccess({ queueId: null });
      }

      const resolvedEmailsMeta: Array<{ xGmMsgId: string; xGmThrid: string }> = [];

      for (const email of deduped.values()) {
        const xGmMsgId = String(email['xGmMsgId'] || '');
        const xGmThrid = String(email['xGmThrid'] || '');
        resolvedEmailsMeta.push({ xGmMsgId, xGmThrid });
      }

      // Optimistic DB update: move email folder associations to Trash immediately
      // so the UI reflects the deletion before the IMAP queue worker confirms.
      for (const email of deduped.values()) {
        const xGmMsgId = String(email['xGmMsgId'] || '');
        const xGmThrid = String(email['xGmThrid'] || '');
        if (!xGmMsgId) {
          continue;
        }

        db.moveEmailFolder(numAccountId, xGmMsgId, folder, trashFolder, null);

        if (xGmThrid) {
          const internalThreadId = db.getThreadInternalId(numAccountId, xGmThrid);
          if (internalThreadId != null) {
            if (!db.threadHasEmailsInFolder(numAccountId, xGmThrid, folder)) {
              db.moveThreadFolder(numAccountId, xGmThrid, folder, trashFolder);
            } else {
              db.upsertThreadFolder(numAccountId, xGmThrid, trashFolder);
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
        },
        description,
      );

      // Register pending operations so FETCH_THREAD blocks IMAP re-fetch until the
      // queue worker confirms the server-side move to Trash. Group by thread.
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
      log.error('Failed to enqueue delete:', err);
      return ipcError('MAIL_DELETE_FAILED', 'Failed to delete emails');
    }
  });

  // Resolve semantic search results: given a list of x_gm_msgid values, return the
  // corresponding threads in the same relevance order. Used by the renderer to convert
  // semantic search x_gm_msgid results into displayable thread objects.
  ipcMain.handle(IPC_CHANNELS.MAIL_SEARCH_BY_MSGIDS, async (_event, accountId: string, xGmMsgIds: unknown) => {
    try {
      if (!accountId || isNaN(Number(accountId))) {
        return ipcError('MAIL_SEARCH_INVALID_INPUT', 'Valid account ID is required');
      }
      if (!Array.isArray(xGmMsgIds) || xGmMsgIds.length === 0) {
        return ipcError('MAIL_SEARCH_INVALID_INPUT', 'At least one message ID is required');
      }
      if (!xGmMsgIds.every((id) => typeof id === 'string')) {
        return ipcError('MAIL_SEARCH_INVALID_INPUT', 'All message IDs must be strings');
      }
      if (xGmMsgIds.length > 200) {
        return ipcError('MAIL_SEARCH_INVALID_INPUT', 'Too many message IDs (max 200)');
      }

      const numAccountId = Number(accountId);
      log.info(`[MAIL_SEARCH_BY_MSGIDS] Resolving ${xGmMsgIds.length} message IDs for account ${accountId}`);

      let results = db.getThreadsByXGmMsgIds(numAccountId, xGmMsgIds as string[]);
      results = attachThreadFolders(results);
      results = attachThreadDraftStatus(results, '', numAccountId);
      results = attachThreadLabels(results, numAccountId);

      log.info(`[MAIL_SEARCH_BY_MSGIDS] Resolved ${results.length} thread(s) for account ${accountId}`);
      return ipcSuccess(results);
    } catch (err) {
      log.error('[MAIL_SEARCH_BY_MSGIDS] Failed:', err);
      return ipcError('MAIL_SEARCH_BY_MSGIDS_FAILED', 'Failed to resolve message IDs');
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

  // Trigger an on-demand sync for a specific folder (Trash/Spam lazy sync).
  // Validates accountId and folder, then calls syncFolderWithReconciliation() which holds
  // the folder lock across the full sync + UID diff sequence.
  // Returns immediately after launching the background sync (fire-and-forget from the renderer's perspective).
  ipcMain.handle(IPC_CHANNELS.MAIL_SYNC_FOLDER, async (_event, payload: unknown): Promise<IpcResponse<void>> => {
    try {
      if (typeof payload !== 'object' || payload === null) {
        return ipcError('MAIL_SYNC_FOLDER_INVALID_INPUT', 'Payload must be an object');
      }

      const { accountId, folder } = payload as Record<string, unknown>;

      if (typeof accountId !== 'string' || accountId.trim().length === 0) {
        return ipcError('MAIL_SYNC_FOLDER_INVALID_INPUT', 'accountId must be a non-empty string');
      }
      const trimmedAccountId = accountId.trim();

      const numAccountId = Number(trimmedAccountId);
      if (!Number.isFinite(numAccountId) || numAccountId <= 0) {
        return ipcError('MAIL_SYNC_FOLDER_INVALID_INPUT', `Invalid accountId: ${trimmedAccountId}`);
      }

      if (typeof folder !== 'string' || folder.trim().length === 0) {
        return ipcError('MAIL_SYNC_FOLDER_INVALID_INPUT', 'folder must be a non-empty string');
      }

      // Verify the account exists in the database (treat renderer input as untrusted)
      const account = db.getAccountById(numAccountId);
      if (!account) {
        return ipcError('MAIL_SYNC_FOLDER_ACCOUNT_NOT_FOUND', `Account ${trimmedAccountId} not found`);
      }

      const trimmedFolder = folder.trim();
      log.info(`[MAIL_SYNC_FOLDER] On-demand sync triggered for folder "${trimmedFolder}" (account ${trimmedAccountId})`);

      // Launch the sync asynchronously — do not await so the renderer gets an immediate response.
      // The renderer will receive a MAIL_FOLDER_UPDATED push event when sync completes.
      const syncService = SyncService.getInstance();
      syncService.syncFolderWithReconciliation(trimmedAccountId, trimmedFolder).catch((err: unknown) => {
        log.error(`[MAIL_SYNC_FOLDER] syncFolderWithReconciliation failed for folder "${trimmedFolder}" (account ${trimmedAccountId}):`, err);
      });

      return ipcSuccess(undefined);
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to trigger folder sync';
      log.error('[MAIL_SYNC_FOLDER] Failed:', err);
      return ipcError('MAIL_SYNC_FOLDER_FAILED', errorMessage);
    }
  });

  // Fetch older emails from IMAP server (scroll-to-load) — enqueued so it runs through the queue with folder lock.
  ipcMain.handle(IPC_CHANNELS.MAIL_FETCH_OLDER, async (_event, accountId: string, folderId: string, beforeDate: string, limit: number) => {
    try {
      const numAccountId = Number(accountId);
      if (!Number.isFinite(numAccountId)) {
        return ipcError('INVALID_ACCOUNT', `Invalid accountId: ${accountId}`);
      }

      const parsedDate = new Date(beforeDate);
      if (isNaN(parsedDate.getTime())) {
        return ipcError('INVALID_DATE', `Invalid beforeDate: ${beforeDate}`);
      }

      const sanitizedLimit = Math.max(1, Number(limit) || 50);

      const queue = MailQueueService.getInstance();
      const dedupKey = `fetch-older:${numAccountId}:${folderId}:${beforeDate}`;
      const queueId = queue.enqueue(
        numAccountId,
        'fetch-older',
        { folder: folderId, beforeDate, limit: sanitizedLimit },
        `Fetch older emails in ${folderId}`,
        undefined,
        dedupKey
      );

      log.info(`MAIL_FETCH_OLDER: enqueued fetch-older (${queueId}) for account ${accountId}, folder ${folderId}`);
      return ipcSuccess({ queueId });
    } catch (err) {
      log.error('Failed to enqueue fetch older:', err);
      return ipcError('MAIL_FETCH_OLDER_FAILED', 'Failed to enqueue fetch older emails');
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
        .filter((row) => !EXCLUDED_FOLDER_PATHS.includes(row.gmailLabelId as string))
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

  // ---- Label CRUD handlers ----

  /** Validation: hex color must be null or match #RRGGBB */
  function isValidColor(color: unknown): boolean {
    if (color === null || color === undefined) {
      return true;
    }
    if (typeof color !== 'string') {
      return false;
    }
    return /^#[0-9A-Fa-f]{6}$/.test(color);
  }

  ipcMain.handle(IPC_CHANNELS.LABEL_CREATE, async (_event, accountId: string, name: string, color: string | null): Promise<IpcResponse> => {
    try {
      const numAccountId = Number(accountId);
      if (!Number.isFinite(numAccountId) || numAccountId <= 0) {
        return ipcError('LABEL_INVALID_ACCOUNT', 'Invalid accountId');
      }

      if (typeof name !== 'string' || name.trim().length === 0) {
        return ipcError('LABEL_INVALID_NAME', 'Label name must be a non-empty string');
      }
      const trimmedName = name.trim();
      if (trimmedName.length > 100) {
        return ipcError('LABEL_INVALID_NAME', 'Label name must not exceed 100 characters');
      }
      if (trimmedName.toLowerCase().startsWith('[gmail]/')) {
        return ipcError('LABEL_INVALID_NAME', 'Label name must not start with [Gmail]/');
      }
      // Reject IMAP-invalid characters: backslash, asterisk, percent
      if (/[\\*%]/.test(trimmedName)) {
        return ipcError('LABEL_INVALID_NAME', 'Label name must not contain \\, *, or %');
      }
      if (!isValidColor(color)) {
        return ipcError('LABEL_INVALID_COLOR', 'Color must be null or a valid hex string (#RRGGBB)');
      }

      // Check uniqueness (case-insensitive) within the account
      const existingLabels = db.getLabelsByAccount(numAccountId);
      const lowerName = trimmedName.toLowerCase();
      const alreadyExists = existingLabels.some(
        (existing) => String(existing['name']).toLowerCase() === lowerName
      );
      if (alreadyExists) {
        return ipcError('LABEL_DUPLICATE_NAME', `A label named "${trimmedName}" already exists`);
      }

      // Create IMAP mailbox
      const imapService = ImapService.getInstance();
      await imapService.createMailbox(accountId, trimmedName);

      // Persist to local DB
      const newId = db.createLabel(numAccountId, trimmedName, trimmedName, color);

      const newLabel = {
        id: newId,
        accountId: numAccountId,
        gmailLabelId: trimmedName,
        name: trimmedName,
        type: 'user',
        color,
        unreadCount: 0,
        totalCount: 0,
      };

      log.info(`[LABEL_CREATE] Created label "${trimmedName}" for account ${accountId}`);
      return ipcSuccess(newLabel);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create label';
      log.error('[LABEL_CREATE] Failed:', err);
      return ipcError('LABEL_CREATE_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LABEL_DELETE, async (_event, accountId: string, gmailLabelId: string): Promise<IpcResponse> => {
    try {
      const numAccountId = Number(accountId);
      if (!Number.isFinite(numAccountId) || numAccountId <= 0) {
        return ipcError('LABEL_INVALID_ACCOUNT', 'Invalid accountId');
      }
      if (typeof gmailLabelId !== 'string' || gmailLabelId.trim().length === 0) {
        return ipcError('LABEL_INVALID_ID', 'gmailLabelId must be a non-empty string');
      }

      const existing = db.getLabelByGmailId(numAccountId, gmailLabelId);
      if (!existing) {
        return ipcError('LABEL_NOT_FOUND', `Label "${gmailLabelId}" not found`);
      }
      if (existing['type'] !== 'user') {
        return ipcError('LABEL_NOT_USER', 'Only user-defined labels can be deleted');
      }

      // Optimistic local DB cleanup: remove label, email_folders, and thread_folders rows
      // before the IMAP operation so the UI updates immediately.
      // If the queue worker fails, the next sync will re-discover the mailbox and re-insert the label.
      db.deleteLabel(numAccountId, gmailLabelId);

      // Enqueue asynchronous IMAP mailbox deletion with dedup to prevent duplicate operations.
      const queueService = MailQueueService.getInstance();
      const labelName = String(existing['name'] ?? gmailLabelId);
      const dedupKey = `delete-label:${numAccountId}:${gmailLabelId}`;
      queueService.enqueue(
        numAccountId,
        'delete-label',
        { gmailLabelId },
        `Delete label "${labelName}"`,
        undefined,
        dedupKey,
      );

      log.info(`[LABEL_DELETE] Queued deletion of label "${gmailLabelId}" for account ${accountId}`);
      return ipcSuccess(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete label';
      log.error('[LABEL_DELETE] Failed:', err);
      return ipcError('LABEL_DELETE_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.LABEL_UPDATE_COLOR, async (_event, accountId: string, gmailLabelId: string, color: string | null): Promise<IpcResponse> => {
    try {
      const numAccountId = Number(accountId);
      if (!Number.isFinite(numAccountId) || numAccountId <= 0) {
        return ipcError('LABEL_INVALID_ACCOUNT', 'Invalid accountId');
      }
      if (typeof gmailLabelId !== 'string' || gmailLabelId.trim().length === 0) {
        return ipcError('LABEL_INVALID_ID', 'gmailLabelId must be a non-empty string');
      }
      if (!isValidColor(color)) {
        return ipcError('LABEL_INVALID_COLOR', 'Color must be null or a valid hex string (#RRGGBB)');
      }

      db.updateLabelColor(numAccountId, gmailLabelId, color);

      log.info(`[LABEL_UPDATE_COLOR] Updated color for "${gmailLabelId}" to ${color} for account ${accountId}`);
      return ipcSuccess({ gmailLabelId, color });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update label color';
      log.error('[LABEL_UPDATE_COLOR] Failed:', err);
      return ipcError('LABEL_UPDATE_COLOR_FAILED', message);
    }
  });
}
