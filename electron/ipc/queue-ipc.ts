import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { MailQueueService, QueueOperationType, QueuePayload } from '../services/mail-queue-service';

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
      const validTypes: QueueOperationType[] = ['draft-create', 'draft-update', 'send', 'move', 'flag', 'delete'];
      if (!validTypes.includes(operation.type)) {
        return ipcError('QUEUE_INVALID_TYPE', `Invalid operation type: ${operation.type}`);
      }

      // Validate accountId is a positive number
      if (typeof operation.accountId !== 'number' || operation.accountId <= 0) {
        return ipcError('QUEUE_INVALID_ACCOUNT', 'accountId must be a positive number');
      }

      // Validate draft-update has originalQueueId
      if (operation.type === 'draft-update') {
        const payload = operation.payload as unknown as Record<string, unknown>;
        if (!payload.originalQueueId || typeof payload.originalQueueId !== 'string') {
          return ipcError('QUEUE_INVALID_PAYLOAD', 'draft-update requires originalQueueId in payload');
        }
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
