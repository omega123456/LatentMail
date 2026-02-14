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
function registerAuthIpcHandlers() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AUTH_LOGIN, async () => {
        try {
            // TODO: Implement in Phase 2 with OAuthService
            main_1.default.info('OAuth login requested');
            return (0, ipc_channels_1.ipcError)('AUTH_NOT_IMPLEMENTED', 'OAuth login not yet implemented');
        }
        catch (err) {
            main_1.default.error('Failed to initiate login:', err);
            return (0, ipc_channels_1.ipcError)('AUTH_LOGIN_FAILED', 'Failed to start authentication');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AUTH_LOGOUT, async (_event, accountId) => {
        try {
            main_1.default.info(`Logout requested for account ${accountId}`);
            return (0, ipc_channels_1.ipcSuccess)(null);
        }
        catch (err) {
            main_1.default.error('Failed to logout:', err);
            return (0, ipc_channels_1.ipcError)('AUTH_LOGOUT_FAILED', 'Failed to logout');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AUTH_GET_ACCOUNTS, async () => {
        try {
            const db = database_service_1.DatabaseService.getInstance();
            const accounts = db.getAccounts();
            return (0, ipc_channels_1.ipcSuccess)(accounts);
        }
        catch (err) {
            main_1.default.error('Failed to get accounts:', err);
            return (0, ipc_channels_1.ipcError)('AUTH_GET_ACCOUNTS_FAILED', 'Failed to retrieve accounts');
        }
    });
}
//# sourceMappingURL=auth-ipc.js.map