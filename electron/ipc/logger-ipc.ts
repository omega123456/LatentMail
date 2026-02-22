import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();

const RECENT_ENTRIES_LIMIT = 100;

export function registerLoggerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.LOGGER_GET_RECENT_ENTRIES, async () => {
    try {
      const entries = await LoggerService.getInstance().getRecentEntries(RECENT_ENTRIES_LIMIT);
      return ipcSuccess({ entries });
    } catch (err) {
      log.error('Failed to get recent log entries:', err);
      return ipcError('LOGGER_READ_FAILED', 'Failed to read log entries');
    }
  });
}
