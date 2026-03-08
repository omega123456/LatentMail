import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { DatabaseService } from '../services/database-service';
import { OAuthService } from '../services/oauth-service';
import { SyncService } from '../services/sync-service';
import { SyncQueueBridge } from '../services/sync-queue-bridge';
import { getCachedAvatarUrl } from '../services/avatar-cache-service';

export function registerAuthIpcHandlers(): void {
  // Initiate OAuth login flow (opens system browser)
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async () => {
    try {
      log.info('OAuth login requested');
      const oauthService = OAuthService.getInstance();
      const account = await oauthService.login();

      // Trigger initial sync and start IDLE for the new account.
      // Uses SyncQueueBridge so the sync goes through the per-account FIFO queue,
      // consistent with background sync and startup behaviour.
      const bridge = SyncQueueBridge.getInstance();
      const syncService = SyncService.getInstance();
      bridge.enqueueSyncForAccount(account.id, false)
        .then(() => {
          return syncService.startIdle(String(account.id), () => {
            bridge.enqueueInboxSync(String(account.id));
          });
        })
        .catch(err => {
          log.warn('Post-login sync or IDLE failed:', err);
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
      const mapped = await Promise.all(
        accounts.map(async (account) => {
          let avatarUrl = account.avatarUrl;
          if (avatarUrl) {
            try {
              avatarUrl = await getCachedAvatarUrl(account.id, avatarUrl);
            } catch (error) {
              log.warn(`[AuthIPC] Failed to resolve cached avatar for account ${account.id}:`, error);
            }
          }

          return {
            id: account.id,
            email: account.email,
            displayName: account.displayName,
            avatarUrl: avatarUrl,
            isActive: account.isActive,
            needsReauth: account.needsReauth,
            lastSyncAt: account.lastSyncAt ?? null,
          };
        })
      );

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
