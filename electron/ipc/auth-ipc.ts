import { ipcMain, BrowserWindow } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, IPC_EVENTS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { DatabaseService } from '../services/database-service';
import { OAuthService } from '../services/oauth-service';
import { SyncQueueBridge } from '../services/sync-queue-bridge';
import { getCachedAvatarUrl } from '../services/avatar-cache-service';
import { TrayService } from '../services/tray-service';

/**
 * Notify the tray and all renderer windows that the global auth state may have
 * changed (e.g. after login, logout, or token revocation).
 *
 * Module-private helper — consolidates the duplicated side-effect that was
 * previously inlined in both the login and logout IPC handlers.
 */
async function notifyAuthStateChanged(db: DatabaseService): Promise<void> {
  try {
    TrayService.getInstance().refreshReauthState();
  } catch (trayError) {
    log.warn('[auth-ipc] TrayService notification failed:', trayError);
  }
  try {
    const allAccounts = db.getAccounts();
    const anyAccountNeedsReauth = allAccounts.some((acct) => acct.needsReauth);
    const allWindows = BrowserWindow.getAllWindows();
    for (const window of allWindows) {
      if (!window.isDestroyed()) {
        window.webContents.send(IPC_EVENTS.AUTH_REFRESH, { needsReauth: anyAccountNeedsReauth });
      }
    }
  } catch (emitError) {
    log.warn('[auth-ipc] AUTH_REFRESH event emission failed:', emitError);
  }
}

export function registerAuthIpcHandlers(): void {
  // Initiate OAuth login flow (opens system browser)
  ipcMain.handle(IPC_CHANNELS.AUTH_LOGIN, async () => {
    try {
      log.info('OAuth login requested');
      const oauthService = OAuthService.getInstance();
      const account = await oauthService.login();

      // Notify tray badge and all renderer windows of the updated auth state.
      await notifyAuthStateChanged(DatabaseService.getInstance());

      // Trigger initial sync and start IDLE for the new account.
      // Routes through SyncQueueBridge so:
      //   1. enqueueSyncForAccount() respects testSuspended / paused state and returns null
      //      when the bridge is suspended or stopped — IDLE is not started in those cases.
      //   2. startIdleForAccount() applies the same lifecycle fencing as the background-sync
      //      startup path, including the IdleLifecycleToken post-connect check that tears down
      //      any IMAP connection that opened while a pause/sleep-stop was in flight.
      const bridge = SyncQueueBridge.getInstance();
      bridge.enqueueSyncForAccount(account.id, false)
        .then((queueId) => {
          if (queueId === null) {
            // Bridge is suspended or stopped — do not start IDLE.
            log.debug(`[AuthIPC] enqueueSyncForAccount returned null for account ${account.id} — skipping IDLE start`);
            return;
          }
          // Start IDLE through the bridge so the lifecycle fence is applied consistently.
          bridge.startIdleForAccount(String(account.id));
        })
        .catch((err) => {
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

      // Notify tray badge and all renderer windows of the updated auth state.
      await notifyAuthStateChanged(DatabaseService.getInstance());

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
