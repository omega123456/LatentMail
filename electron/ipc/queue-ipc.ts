import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { MailQueueService, QueueOperationType, QueuePayload, AddLabelsPayload, RemoveLabelsPayload } from '../services/mail-queue-service';
import { DatabaseService } from '../services/database-service';
import { ALL_MAIL_PATH } from '../services/sync-service';

export function registerQueueIpcHandlers(): void {
  const queueService = MailQueueService.getInstance();

  // Enqueue a mail operation — returns { queueId } immediately
  ipcMain.handle(IPC_CHANNELS.QUEUE_ENQUEUE, async (_event, operation: {
    type: QueueOperationType;
    accountId: number;
    payload: QueuePayload;
    description?: string;
    queueId?: string;
  }) => {
    try {
      if (!operation || typeof operation !== 'object') {
        return ipcError('QUEUE_INVALID_OPERATION', 'Operation must be an object');
      }
      if (!operation.type || !operation.accountId || !operation.payload) {
        return ipcError('QUEUE_INVALID_OPERATION', 'Missing required fields: type, accountId, payload');
      }

      // Validate operation type
      const validTypes: QueueOperationType[] = ['draft-create', 'draft-update', 'send', 'move', 'flag', 'delete', 'add-labels', 'remove-labels'];
      if (!validTypes.includes(operation.type)) {
        return ipcError('QUEUE_INVALID_TYPE', `Invalid operation type: ${operation.type}`);
      }

      // Validate accountId is a positive number
      if (typeof operation.accountId !== 'number' || operation.accountId <= 0) {
        return ipcError('QUEUE_INVALID_ACCOUNT', 'accountId must be a positive number');
      }

      // Validate draft-update has originalQueueId OR serverDraftXGmMsgId
      if (operation.type === 'draft-update') {
        const payload = operation.payload as unknown as Record<string, unknown>;
        const hasOriginalQueueId = payload.originalQueueId && typeof payload.originalQueueId === 'string';
        const hasServerDraftId = payload.serverDraftXGmMsgId && typeof payload.serverDraftXGmMsgId === 'string';
        if (!hasOriginalQueueId && !hasServerDraftId) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'draft-update requires originalQueueId or serverDraftXGmMsgId in payload');
        }
      }

      // Validate move payload
      if (operation.type === 'move') {
        const payload = operation.payload as unknown as Record<string, unknown>;
        if (!Array.isArray(payload.xGmMsgIds) || payload.xGmMsgIds.length === 0) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'move requires non-empty xGmMsgIds array in payload');
        }
        if (!payload.targetFolder || typeof payload.targetFolder !== 'string') {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'move requires targetFolder string in payload');
        }
      }

      // Validate flag payload
      if (operation.type === 'flag') {
        const payload = operation.payload as unknown as Record<string, unknown>;
        if (!Array.isArray(payload.xGmMsgIds) || payload.xGmMsgIds.length === 0) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'flag requires non-empty xGmMsgIds array in payload');
        }
        if (!payload.flag || typeof payload.flag !== 'string') {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'flag requires flag string in payload');
        }
        if (typeof payload.value !== 'boolean') {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'flag requires value boolean in payload');
        }
      }

      // Validate send payload
      if (operation.type === 'send') {
        const payload = operation.payload as unknown as Record<string, unknown>;
        if (!payload.to || typeof payload.to !== 'string') {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'send requires non-empty to string in payload');
        }
        if (typeof payload.subject !== 'string' && payload.subject !== undefined) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'send subject must be a string if provided');
        }
      }

      // Validate delete payload
      if (operation.type === 'delete') {
        const payload = operation.payload as unknown as Record<string, unknown>;
        if (!Array.isArray(payload.xGmMsgIds) || payload.xGmMsgIds.length === 0) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'delete requires non-empty xGmMsgIds array in payload');
        }
        if (!payload.folder || typeof payload.folder !== 'string') {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'delete requires folder string in payload');
        }
      }

      // Validate add-labels payload shape
      if (operation.type === 'add-labels') {
        const addCheck = operation.payload as unknown as Record<string, unknown>;
        if (!Array.isArray(addCheck['xGmMsgIds']) || (addCheck['xGmMsgIds'] as unknown[]).length === 0) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'add-labels requires non-empty xGmMsgIds array');
        }
        if (!Array.isArray(addCheck['targetLabels']) || (addCheck['targetLabels'] as unknown[]).length === 0) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'add-labels requires non-empty targetLabels array');
        }
        if (typeof addCheck['threadId'] !== 'string') {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'add-labels requires threadId string');
        }
      }

      // Validate remove-labels payload shape
      if (operation.type === 'remove-labels') {
        const removeCheck = operation.payload as unknown as Record<string, unknown>;
        if (!Array.isArray(removeCheck['xGmMsgIds']) || (removeCheck['xGmMsgIds'] as unknown[]).length === 0) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'remove-labels requires non-empty xGmMsgIds array');
        }
        if (!Array.isArray(removeCheck['targetLabels']) || (removeCheck['targetLabels'] as unknown[]).length === 0) {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'remove-labels requires non-empty targetLabels array');
        }
        if (typeof removeCheck['threadId'] !== 'string') {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'remove-labels requires threadId string');
        }
      }

      // For add-labels: resolve source UIDs at enqueue time (prefer [Gmail]/All Mail)
      if (operation.type === 'add-labels') {
        const db = DatabaseService.getInstance();
        const addPayload = operation.payload as unknown as AddLabelsPayload;
        const resolvedEmails: AddLabelsPayload['resolvedEmails'] = [];
        for (const xGmMsgId of addPayload.xGmMsgIds) {
          const folderUids = db.getFolderUidsForEmail(operation.accountId, xGmMsgId);
          if (folderUids.length === 0) {
            continue;
          }
          // Prefer All Mail as source; fall back to first available folder
          const allMailEntry = folderUids.find((entry) => entry.folder === ALL_MAIL_PATH);
          const source = allMailEntry ?? folderUids[0];
          resolvedEmails.push({
            xGmMsgId,
            sourceFolder: source.folder,
            uid: source.uid,
          });
        }
        (operation.payload as unknown as AddLabelsPayload).resolvedEmails = resolvedEmails;
        if (resolvedEmails.length === 0 && addPayload.xGmMsgIds.length > 0) {
          log.warn(`[QUEUE_ENQUEUE] add-labels: no UIDs resolved for ${addPayload.xGmMsgIds.join(', ')} — skipping`);
          return ipcSuccess({ queueId: 'skipped' });
        }
      }

      // For remove-labels: resolve UIDs from each specific target label folder
      if (operation.type === 'remove-labels') {
        const db = DatabaseService.getInstance();
        const removePayload = operation.payload as unknown as RemoveLabelsPayload;
        const resolvedEmails: RemoveLabelsPayload['resolvedEmails'] = [];
        for (const xGmMsgId of removePayload.xGmMsgIds) {
          const folderUids = db.getFolderUidsForEmail(operation.accountId, xGmMsgId);
          for (const labelFolder of removePayload.targetLabels) {
            const entry = folderUids.find((folderEntry) => folderEntry.folder === labelFolder);
            if (entry) {
              resolvedEmails.push({
                xGmMsgId,
                labelFolder,
                uid: entry.uid,
              });
            }
          }
        }
        (operation.payload as unknown as RemoveLabelsPayload).resolvedEmails = resolvedEmails;
        // Do not skip when resolvedEmails is empty: label folders often have no UID stored
        // (e.g. after add-labels only folder is written). The worker will resolve UIDs dynamically.
      }

      const description = operation.description || `${operation.type} operation`;
      const queueId = queueService.enqueue(
        operation.accountId,
        operation.type,
        operation.payload,
        description,
        operation.queueId,
      );

      return ipcSuccess({ queueId });
    } catch (err) {
      log.error('Failed to enqueue operation:', err);
      return ipcError('QUEUE_ENQUEUE_FAILED', 'Failed to enqueue operation');
    }
  });

  // Get current queue state (all items)
  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_STATUS, async () => {
    try {
      const items = queueService.getAllItems();
      return ipcSuccess({ items });
    } catch (err) {
      log.error('Failed to get queue status:', err);
      return ipcError('QUEUE_STATUS_FAILED', 'Failed to get queue status');
    }
  });

  // Retry failed operations (optionally a specific one)
  ipcMain.handle(IPC_CHANNELS.QUEUE_RETRY_FAILED, async (_event, params?: { queueId?: string }) => {
    try {
      const retriedCount = queueService.retryFailed(params?.queueId);
      return ipcSuccess({ retriedCount });
    } catch (err) {
      log.error('Failed to retry failed operations:', err);
      return ipcError('QUEUE_RETRY_FAILED', 'Failed to retry failed operations');
    }
  });

  // Clear completed items
  ipcMain.handle(IPC_CHANNELS.QUEUE_CLEAR_COMPLETED, async () => {
    try {
      const clearedCount = queueService.clearCompleted();
      return ipcSuccess({ clearedCount });
    } catch (err) {
      log.error('Failed to clear completed operations:', err);
      return ipcError('QUEUE_CLEAR_FAILED', 'Failed to clear completed operations');
    }
  });

  // Cancel a pending operation
  ipcMain.handle(IPC_CHANNELS.QUEUE_CANCEL, async (_event, params: { queueId: string }) => {
    try {
      const cancelled = queueService.cancel(params.queueId);
      return ipcSuccess({ cancelled });
    } catch (err) {
      log.error('Failed to cancel operation:', err);
      return ipcError('QUEUE_CANCEL_FAILED', 'Failed to cancel operation');
    }
  });

  // Get count of pending/processing items
  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_PENDING_COUNT, async () => {
    try {
      const count = queueService.getPendingCount();
      return ipcSuccess({ count });
    } catch (err) {
      log.error('Failed to get pending count:', err);
      return ipcError('QUEUE_PENDING_COUNT_FAILED', 'Failed to get pending count');
    }
  });

  log.info('Queue IPC handlers registered');
}
