import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { DatabaseService } from '../services/database-service';
import { FilterService } from '../services/filter-service';

export function registerFilterIpcHandlers(): void {
  // Manual trigger: run all enabled filters on unfiltered INBOX emails
  ipcMain.handle(IPC_CHANNELS.FILTER_APPLY_ALL, async (_event, accountId: number) => {
    try {
      if (!accountId || typeof accountId !== 'number' || accountId <= 0) {
        log.warn(`[FilterIPC] Invalid account ID provided: ${accountId}`);
        return ipcError('FILTER_INVALID_INPUT', 'Valid account ID is required');
      }

      log.info(`[FilterIPC] Manual filter apply triggered for account ${accountId}`);
      const filterService = FilterService.getInstance();
      const result = await filterService.processNewEmails(accountId);
      log.info(`[FilterIPC] Manual filter apply completed for account ${accountId}: ${result.emailsProcessed} processed, ${result.emailsMatched} matched, ${result.actionsDispatched} actions dispatched, ${result.errors} errors`);

      return ipcSuccess(result);
    } catch (err) {
      log.error(`[FilterIPC] Failed to apply filters for account ${accountId}:`, err);
      return ipcError('FILTER_APPLY_FAILED', 'Failed to apply filters');
    }
  });

  // Get user labels for an account (for sidebar display)
  ipcMain.handle(IPC_CHANNELS.DB_GET_USER_LABELS, (_event, accountId: number) => {
    try {
      if (!accountId || typeof accountId !== 'number' || accountId <= 0) {
        return ipcError('DB_INVALID_INPUT', 'Valid account ID is required');
      }

      const db = DatabaseService.getInstance();
      const labels = db.getUserLabels(accountId);
      return ipcSuccess({ labels });
    } catch (err) {
      log.error('[FilterIPC] Failed to get user labels:', err);
      return ipcError('DB_READ_FAILED', 'Failed to get user labels');
    }
  });

  log.info('Filter IPC handlers registered');
}
