import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';

export function registerAuthIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async () => {
    try {
      // TODO: Implement in Phase 2 with OAuthService
      log.info('OAuth login requested');
      return ipcError('AUTH_NOT_IMPLEMENTED', 'OAuth login not yet implemented');
    } catch (err) {
      log.error('Failed to initiate login:', err);
      return ipcError('AUTH_LOGIN_FAILED', 'Failed to start authentication');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async (_event, accountId: string) => {
    try {
      log.info(`Logout requested for account ${accountId}`);
      return ipcSuccess(null);
    } catch (err) {
      log.error('Failed to logout:', err);
      return ipcError('AUTH_LOGOUT_FAILED', 'Failed to logout');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AUTH_GET_ACCOUNTS, async () => {
    try {
      const db = DatabaseService.getInstance();
      const accounts = db.getAccounts();
      return ipcSuccess(accounts);
    } catch (err) {
      log.error('Failed to get accounts:', err);
      return ipcError('AUTH_GET_ACCOUNTS_FAILED', 'Failed to retrieve accounts');
    }
  });
}
