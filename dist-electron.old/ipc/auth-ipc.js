"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAuthIpcHandlers = registerAuthIpcHandlers;
const electron_1 = require("electron");
const main_1 = __importDefault(require("electron-log/main"));
const ipc_channels_1 = require("./ipc-channels");
const database_service_1 = require("../services/database-service");
const oauth_service_1 = require("../services/oauth-service");
function registerAuthIpcHandlers() {
    // Initiate OAuth login flow (opens system browser)
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AUTH_LOGIN, async () => {
        try {
            main_1.default.info('OAuth login requested');
            const oauthService = oauth_service_1.OAuthService.getInstance();
            const account = await oauthService.login();
            // Map to the format the renderer expects
            return (0, ipc_channels_1.ipcSuccess)({
                id: account.id,
                email: account.email,
                displayName: account.displayName,
                avatarUrl: account.avatarUrl,
            });
        }
        catch (err) {
            main_1.default.error('Failed to initiate login:', err);
            const message = err.message || 'Failed to start authentication';
            if (message.includes('GOOGLE_CLIENT_ID')) {
                return (0, ipc_channels_1.ipcError)('AUTH_NOT_CONFIGURED', message);
            }
            if (message.includes('timed out')) {
                return (0, ipc_channels_1.ipcError)('AUTH_TIMEOUT', 'Authentication timed out. Please try again.');
            }
            if (message.includes('denied')) {
                return (0, ipc_channels_1.ipcError)('AUTH_DENIED', 'Authentication was denied. Please try again and grant the required permissions.');
            }
            return (0, ipc_channels_1.ipcError)('AUTH_LOGIN_FAILED', message);
        }
    });
    // Remove an account (revoke tokens, delete data, clear credentials)
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AUTH_LOGOUT, async (_event, accountId) => {
        try {
            main_1.default.info(`Logout requested for account ${accountId}`);
            const oauthService = oauth_service_1.OAuthService.getInstance();
            await oauthService.logout(accountId);
            return (0, ipc_channels_1.ipcSuccess)(null);
        }
        catch (err) {
            main_1.default.error('Failed to logout:', err);
            return (0, ipc_channels_1.ipcError)('AUTH_LOGOUT_FAILED', err.message || 'Failed to remove account');
        }
    });
    // Get all active accounts
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AUTH_GET_ACCOUNTS, async () => {
        try {
            const db = database_service_1.DatabaseService.getInstance();
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
            return (0, ipc_channels_1.ipcSuccess)(mapped);
        }
        catch (err) {
            main_1.default.error('Failed to get accounts:', err);
            return (0, ipc_channels_1.ipcError)('AUTH_GET_ACCOUNTS_FAILED', 'Failed to retrieve accounts');
        }
    });
    // Get account count (used by route guards)
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AUTH_GET_ACCOUNT_COUNT, async () => {
        try {
            const db = database_service_1.DatabaseService.getInstance();
            const count = db.getAccountCount();
            return (0, ipc_channels_1.ipcSuccess)(count);
        }
        catch (err) {
            main_1.default.error('Failed to get account count:', err);
            return (0, ipc_channels_1.ipcError)('AUTH_GET_ACCOUNT_COUNT_FAILED', 'Failed to get account count');
        }
    });
}
//# sourceMappingURL=auth-ipc.js.map