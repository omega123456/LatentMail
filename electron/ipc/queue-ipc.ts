import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { MailQueueService, QueueOperationType, QueuePayload, AddLabelsPayload, RemoveLabelsPayload } from '../services/mail-queue-service';
import { BodyFetchQueueService } from '../services/body-fetch-queue-service';
import { DatabaseService } from '../services/database-service';
import { ALL_MAIL_PATH } from '../services/sync-service';

interface QueueEnqueueOperation {
  type: QueueOperationType;
  accountId: number;
  payload: QueuePayload;
  description?: string;
  queueId?: string;
}

interface UidResolutionEntry {
  folder: string;
  uid: number;
}

const VALID_ENQUEUE_TYPES: QueueOperationType[] = [
  'draft-create',
  'draft-update',
  'send',
  'move',
  'flag',
  'delete',
  'delete-label',
  'add-labels',
  'remove-labels',
];

function validateOperationEnvelope(operation: unknown): ReturnType<typeof ipcError> | null {
  if (!operation || typeof operation !== 'object') {
    return ipcError('QUEUE_INVALID_OPERATION', 'Operation must be an object');
  }

  const operationRecord = operation as Record<string, unknown>;
  const hasType = Object.prototype.hasOwnProperty.call(operationRecord, 'type') && operationRecord['type'] != null;
  const hasAccountId = Object.prototype.hasOwnProperty.call(operationRecord, 'accountId') && operationRecord['accountId'] != null;
  const hasPayload = Object.prototype.hasOwnProperty.call(operationRecord, 'payload') && operationRecord['payload'] != null;

  if (!hasType || !hasAccountId || !hasPayload) {
    return ipcError('QUEUE_INVALID_OPERATION', 'Missing required fields: type, accountId, payload');
  }

  return null;
}

function validatePayloadByType(operation: QueueEnqueueOperation): ReturnType<typeof ipcError> | null {
  if (!VALID_ENQUEUE_TYPES.includes(operation.type)) {
    return ipcError('QUEUE_INVALID_TYPE', `Invalid operation type: ${operation.type}`);
  }

  if (typeof operation.accountId !== 'number' || operation.accountId <= 0) {
    return ipcError('QUEUE_INVALID_ACCOUNT', 'accountId must be a positive number');
  }

  if (operation.type === 'draft-update') {
    const payload = operation.payload as unknown as Record<string, unknown>;
    const hasOriginalQueueId = payload.originalQueueId && typeof payload.originalQueueId === 'string';
    const hasServerDraftId = payload.serverDraftXGmMsgId && typeof payload.serverDraftXGmMsgId === 'string';
    if (!hasOriginalQueueId && !hasServerDraftId) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'draft-update requires originalQueueId or serverDraftXGmMsgId in payload');
    }
  }

  if (operation.type === 'move') {
    const payload = operation.payload as unknown as Record<string, unknown>;
    if (!Array.isArray(payload.xGmMsgIds) || payload.xGmMsgIds.length === 0) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'move requires non-empty xGmMsgIds array in payload');
    }
    if (!payload.targetFolder || typeof payload.targetFolder !== 'string') {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'move requires targetFolder string in payload');
    }
  }

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

  if (operation.type === 'send') {
    const payload = operation.payload as unknown as Record<string, unknown>;
    if (!payload.to || typeof payload.to !== 'string') {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'send requires non-empty to string in payload');
    }
    if (typeof payload.subject !== 'string' && payload.subject !== undefined) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'send subject must be a string if provided');
    }
  }

  if (operation.type === 'delete') {
    const payload = operation.payload as unknown as Record<string, unknown>;
    if (!Array.isArray(payload.xGmMsgIds) || payload.xGmMsgIds.length === 0) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'delete requires non-empty xGmMsgIds array in payload');
    }
    if (!payload.folder || typeof payload.folder !== 'string') {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'delete requires folder string in payload');
    }
  }

  if (operation.type === 'delete-label') {
    const payload = operation.payload as unknown as Record<string, unknown>;
    if (!payload.gmailLabelId || typeof payload.gmailLabelId !== 'string' || (payload.gmailLabelId as string).trim().length === 0) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'delete-label requires a non-empty gmailLabelId string in payload');
    }
  }

  if (operation.type === 'add-labels') {
    const payload = operation.payload as unknown as Record<string, unknown>;
    if (!Array.isArray(payload['xGmMsgIds']) || (payload['xGmMsgIds'] as unknown[]).length === 0) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'add-labels requires non-empty xGmMsgIds array');
    }
    if (!Array.isArray(payload['targetLabels']) || (payload['targetLabels'] as unknown[]).length === 0) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'add-labels requires non-empty targetLabels array');
    }
    if (typeof payload['threadId'] !== 'string') {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'add-labels requires threadId string');
    }
  }

  if (operation.type === 'remove-labels') {
    const payload = operation.payload as unknown as Record<string, unknown>;
    if (!Array.isArray(payload['xGmMsgIds']) || (payload['xGmMsgIds'] as unknown[]).length === 0) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'remove-labels requires non-empty xGmMsgIds array');
    }
    if (!Array.isArray(payload['targetLabels']) || (payload['targetLabels'] as unknown[]).length === 0) {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'remove-labels requires non-empty targetLabels array');
    }
    if (typeof payload['threadId'] !== 'string') {
      return ipcError('QUEUE_INVALID_PAYLOAD', 'remove-labels requires threadId string');
    }
  }

  return null;
}

function resolveEmailFolderUids(accountId: number, xGmMsgId: string): UidResolutionEntry[] {
  const db = DatabaseService.getInstance();
  return db.getFolderUidsForEmail(accountId, xGmMsgId).map((entry) => ({
    folder: entry.folder,
    uid: entry.uid,
  }));
}

function preparePayloadForEnqueue(operation: QueueEnqueueOperation): ReturnType<typeof ipcSuccess> | null {
  if (operation.type === 'add-labels') {
    const addPayload = operation.payload as AddLabelsPayload;
    const resolvedEmails: AddLabelsPayload['resolvedEmails'] = [];

    for (const xGmMsgId of addPayload.xGmMsgIds) {
      const folderUids = resolveEmailFolderUids(operation.accountId, xGmMsgId);
      if (folderUids.length === 0) {
        continue;
      }

      const allMailEntry = folderUids.find((entry) => entry.folder === ALL_MAIL_PATH);
      const source = allMailEntry ?? folderUids[0];
      resolvedEmails.push({
        xGmMsgId,
        sourceFolder: source.folder,
        uid: source.uid,
      });
    }

    addPayload.resolvedEmails = resolvedEmails;
    if (resolvedEmails.length === 0 && addPayload.xGmMsgIds.length > 0) {
      log.warn(`[QUEUE_ENQUEUE] add-labels: no UIDs resolved for ${addPayload.xGmMsgIds.join(', ')} — skipping`);
      return ipcSuccess({ queueId: 'skipped' });
    }
  }

  if (operation.type === 'remove-labels') {
    const removePayload = operation.payload as RemoveLabelsPayload;
    const resolvedEmails: RemoveLabelsPayload['resolvedEmails'] = [];

    for (const xGmMsgId of removePayload.xGmMsgIds) {
      const folderUids = resolveEmailFolderUids(operation.accountId, xGmMsgId);
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

    removePayload.resolvedEmails = resolvedEmails;
  }

  return null;
}

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
      const envelopeError = validateOperationEnvelope(operation);
      if (envelopeError) {
        return envelopeError;
      }

      const typedOperation = operation as QueueEnqueueOperation;

      const payloadError = validatePayloadByType(typedOperation);
      if (payloadError) {
        return payloadError;
      }

      const prepareResult = preparePayloadForEnqueue(typedOperation);
      if (prepareResult) {
        return prepareResult;
      }

      const description = typedOperation.description || `${typedOperation.type} operation`;
      const queueId = queueService.enqueue(
        typedOperation.accountId,
        typedOperation.type,
        typedOperation.payload,
        description,
        typedOperation.queueId,
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

  // Body-fetch queue: get all items
  ipcMain.handle(IPC_CHANNELS.BODY_QUEUE_GET_STATUS, async () => {
    try {
      return { success: true, data: BodyFetchQueueService.getInstance().getAllItems() };
    } catch (err) {
      log.error('Failed to get body queue status:', err);
      return ipcError('BODY_QUEUE_STATUS_FAILED', 'Failed to get body queue status');
    }
  });

  // Body-fetch queue: clear completed items
  ipcMain.handle(IPC_CHANNELS.BODY_QUEUE_CLEAR_COMPLETED, async () => {
    try {
      BodyFetchQueueService.getInstance().clearCompleted();
      return { success: true };
    } catch (err) {
      log.error('Failed to clear body queue completed items:', err);
      return ipcError('BODY_QUEUE_CLEAR_FAILED', 'Failed to clear body queue completed items');
    }
  });

  // Body-fetch queue: cancel a specific pending item
  ipcMain.handle(IPC_CHANNELS.BODY_QUEUE_CANCEL, async (_event, queueId: string) => {
    try {
      const result = BodyFetchQueueService.getInstance().cancel(queueId);
      return { success: true, data: result };
    } catch (err) {
      log.error('Failed to cancel body queue item:', err);
      return ipcError('BODY_QUEUE_CANCEL_FAILED', 'Failed to cancel body queue item');
    }
  });

  log.info('Queue IPC handlers registered');
}
