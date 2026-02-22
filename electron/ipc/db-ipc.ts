import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import type { LogLevel } from '../services/logger-service';

const log = LoggerService.getInstance();

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

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

  ipcMain.handle(IPC_CHANNELS.DB_SET_LOG_LEVEL, async (_event, level: unknown) => {
    if (typeof level !== 'string' || !(VALID_LOG_LEVELS as readonly string[]).includes(level)) {
      return ipcError(
        'INVALID_LOG_LEVEL',
        `Invalid log level: '${String(level)}'. Must be one of: ${VALID_LOG_LEVELS.join(', ')}`
      );
    }
    try {
      LoggerService.getInstance().setLevel(level as LogLevel);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to set log level:', err);
      return ipcError('DB_WRITE_FAILED', 'Failed to apply log level');
    }
  });

  // ---- Filter CRUD handlers ----

  ipcMain.handle(IPC_CHANNELS.DB_GET_FILTERS, (_event, accountId: number) => {
    try {
      if (!accountId || typeof accountId !== 'number') {
        return ipcError('DB_INVALID_INPUT', 'Account ID is required');
      }
      const db = DatabaseService.getInstance();
      const filters = db.getFilters(accountId);
      return ipcSuccess({ filters });
    } catch (err) {
      log.error('Failed to get filters:', err);
      return ipcError('DB_READ_FAILED', 'Failed to read filters');
    }
  });

  ipcMain.handle(IPC_CHANNELS.DB_SAVE_FILTER, (_event, filter: {
    accountId: number;
    name: string;
    conditions: string;
    actions: string;
    isEnabled: boolean;
    isAiGenerated: boolean;
    sortOrder?: number;
  }) => {
    try {
      if (!filter || !filter.accountId || !filter.name) {
        return ipcError('DB_INVALID_INPUT', 'Filter data is incomplete');
      }
      if (typeof filter.conditions !== 'string' || typeof filter.actions !== 'string') {
        return ipcError('DB_INVALID_INPUT', 'Conditions and actions must be JSON strings');
      }
      // Validate JSON is parseable
      try {
        JSON.parse(filter.conditions);
        JSON.parse(filter.actions);
      } catch {
        return ipcError('DB_INVALID_INPUT', 'Conditions or actions contain invalid JSON');
      }
      const db = DatabaseService.getInstance();
      const id = db.saveFilter(filter);
      return ipcSuccess({ id });
    } catch (err) {
      log.error('Failed to save filter:', err);
      return ipcError('DB_WRITE_FAILED', 'Failed to save filter');
    }
  });

  ipcMain.handle(IPC_CHANNELS.DB_UPDATE_FILTER, (_event, filter: {
    id: number;
    name: string;
    conditions: string;
    actions: string;
    isEnabled: boolean;
    sortOrder?: number;
  }) => {
    try {
      if (!filter || !filter.id || !filter.name) {
        return ipcError('DB_INVALID_INPUT', 'Filter data is incomplete');
      }
      if (typeof filter.conditions !== 'string' || typeof filter.actions !== 'string') {
        return ipcError('DB_INVALID_INPUT', 'Conditions and actions must be JSON strings');
      }
      // Validate JSON is parseable
      try {
        JSON.parse(filter.conditions);
        JSON.parse(filter.actions);
      } catch {
        return ipcError('DB_INVALID_INPUT', 'Conditions or actions contain invalid JSON');
      }
      const db = DatabaseService.getInstance();
      db.updateFilter(filter);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to update filter:', err);
      return ipcError('DB_WRITE_FAILED', 'Failed to update filter');
    }
  });

  ipcMain.handle(IPC_CHANNELS.DB_DELETE_FILTER, (_event, filterId: number) => {
    try {
      if (!filterId || typeof filterId !== 'number') {
        return ipcError('DB_INVALID_INPUT', 'Filter ID is required');
      }
      const db = DatabaseService.getInstance();
      db.deleteFilter(filterId);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to delete filter:', err);
      return ipcError('DB_WRITE_FAILED', 'Failed to delete filter');
    }
  });

  ipcMain.handle(IPC_CHANNELS.DB_TOGGLE_FILTER, (_event, filterId: number, isEnabled: boolean) => {
    try {
      if (!filterId || typeof filterId !== 'number') {
        return ipcError('DB_INVALID_INPUT', 'Filter ID is required');
      }
      const db = DatabaseService.getInstance();
      db.toggleFilter(filterId, isEnabled);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to toggle filter:', err);
      return ipcError('DB_WRITE_FAILED', 'Failed to toggle filter');
    }
  });
}
