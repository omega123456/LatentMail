"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerSystemIpcHandlers = registerSystemIpcHandlers;
const electron_1 = require("electron");
const ipc_channels_1 = require("./ipc-channels");
function registerSystemIpcHandlers() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.SYSTEM_MINIMIZE, (event) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        win?.minimize();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.SYSTEM_MAXIMIZE, (event) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        if (win) {
            if (win.isMaximized()) {
                win.unmaximize();
            }
            else {
                win.maximize();
            }
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.SYSTEM_CLOSE, (event) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        win?.close();
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.SYSTEM_IS_MAXIMIZED, (event) => {
        const win = electron_1.BrowserWindow.fromWebContents(event.sender);
        return win?.isMaximized() ?? false;
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.SYSTEM_GET_PLATFORM, () => {
        return process.platform;
    });
}
//# sourceMappingURL=system-ipc.js.map