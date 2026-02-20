import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { DatabaseService } from '../services/database-service';
import { OAuthService } from '../services/oauth-service';
import { SyncService } from '../services/sync-service';

export function registerAuthIpcHandlers(): void {
  // Initiate OAuth login flow (opens system browser)
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async () => {
    try {
      log.info('OAuth login requested');
      const oauthService = OAuthService.getInstance();
      const account = await oauthService.login();

      // Trigger initial sync and IDLE for the new account (same as main.ts does at startup)
      const syncService = SyncService.getInstance();
      syncService.syncAccount(String(account.id))
        .then(() => {
          syncService.startIdle(String(account.id)).catch(err => {
            log.warn(`Failed to start IDLE for account ${account.id}:`, err);
          });
        })
        .catch(err => {
          log.warn('Post-login sync failed:', err);
        });

      // Map to the format the renderer expects
      return ipcSuccess({
        id: account.id,
        email: account.email,
        displayName: account.displayName,
        avatarUrl: account.avatarUrl,
      });
    } catch (err: any) {
      log.error('Failed to initiate login:', err);
      const message = err.message || 'Failed to start authentication';

      if (message.includes('GOOGLE_CLIENT_ID')) {
        return ipcError('AUTH_NOT_CONFIGURED', message);
      }
      if (message.includes('client_secret is missing')) {
        return ipcError('AUTH_NOT_CONFIGURED', 'Add GOOGLE_CLIENT_SECRET to your .env file. Required when using a Web application OAuth client in Google Cloud Console.');
      }
      if (message.includes('timed out')) {
        return ipcError('AUTH_TIMEOUT', 'Authentication timed out. Please try again.');
      }
      if (message.includes('denied')) {
        return ipcError('AUTH_DENIED', 'Authentication was denied. Please try again and grant the required permissions.');
      }

      return ipcError('AUTH_LOGIN_FAILED', message);
    }
  });

  // Remove an account (revoke tokens, delete data, clear credentials)
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGOUT, async (_event, accountId: string) => {
    try {
      log.info(`Logout requested for account ${accountId}`);
      const oauthService = OAuthService.getInstance();
      await oauthService.logout(accountId);
      return ipcSuccess(null);
    } catch (err: any) {
      log.error('Failed to logout:', err);
      return ipcError('AUTH_LOGOUT_FAILED', err.message || 'Failed to remove account');
    }
  });

  // Get all active accounts
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_ACCOUNTS, async () => {
    try {
      const db = DatabaseService.getInstance();
      const accounts = db.getAccounts();

      // Map snake_case DB fields to camelCase for the renderer
      const mapped = accounts.map(a => ({
        id: a.id,
        email: a.email,
        displayName: a.display_name,
        avatarUrl: a.avatar_url,
        isActive: a.is_active === 1,
        needsReauth: a.needs_reauth === 1,
      }));

      return ipcSuccess(mapped);
    } catch (err: any) {
      log.error('Failed to get accounts:', err);
      return ipcError('AUTH_GET_ACCOUNTS_FAILED', 'Failed to retrieve accounts');
    }
  });

  // Get account count (used by route guards)
  ipcMain.handle(IPC_CHANNELS.AUTH_GET_ACCOUNT_COUNT, async () => {
    try {
      const db = DatabaseService.getInstance();
      const count = db.getAccountCount();
      return ipcSuccess(count);
    } catch (err: any) {
      log.error('Failed to get account count:', err);
      return ipcError('AUTH_GET_ACCOUNT_COUNT_FAILED', 'Failed to get account count');
    }
  });
}
