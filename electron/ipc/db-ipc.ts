import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';

export function registerDbIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.DB_GET_SETTINGS, (_event, keys?: string[]) => {
    try {
      const db = DatabaseService.getInstance();
      if (keys && keys.length > 0) {
        const result: Record<string, string | null> = {};
        for (const key of keys) {
          result[key] = db.getSetting(key);
        }
        return ipcSuccess(result);
      }
      return ipcSuccess(db.getAllSettings());
    } catch (err) {
      log.error('Failed to get settings:', err);
      return ipcError('DB_READ_FAILED', 'Failed to read settings');
    }
  });

  ipcMain.handle(IPC_CHANNELS.DB_SET_SETTINGS, (_event, settings: Record<string, string>) => {
    try {
      const db = DatabaseService.getInstance();
      for (const [key, value] of Object.entries(settings)) {
        db.setSetting(key, value);
      }
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to set settings:', err);
      return ipcError('DB_WRITE_FAILED', 'Failed to write settings');
    }
  });
}
