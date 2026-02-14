"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerDbIpcHandlers = registerDbIpcHandlers;
const electron_1 = require("electron");
const main_1 = __importDefault(require("electron-log/main"));
const ipc_channels_1 = require("./ipc-channels");
const database_service_1 = require("../services/database-service");
function registerDbIpcHandlers() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.DB_GET_SETTINGS, (_event, keys) => {
        try {
            const db = database_service_1.DatabaseService.getInstance();
            if (keys && keys.length > 0) {
                const result = {};
                for (const key of keys) {
                    result[key] = db.getSetting(key);
                }
                return (0, ipc_channels_1.ipcSuccess)(result);
            }
            return (0, ipc_channels_1.ipcSuccess)(db.getAllSettings());
        }
        catch (err) {
            main_1.default.error('Failed to get settings:', err);
            return (0, ipc_channels_1.ipcError)('DB_READ_FAILED', 'Failed to read settings');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.DB_SET_SETTINGS, (_event, settings) => {
        try {
            const db = database_service_1.DatabaseService.getInstance();
            for (const [key, value] of Object.entries(settings)) {
                db.setSetting(key, value);
            }
            return (0, ipc_channels_1.ipcSuccess)(null);
        }
        catch (err) {
            main_1.default.error('Failed to set settings:', err);
            return (0, ipc_channels_1.ipcError)('DB_WRITE_FAILED', 'Failed to write settings');
        }
    });
}
//# sourceMappingURL=db-ipc.js.map