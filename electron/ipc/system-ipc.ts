import { ipcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from './ipc-channels';

export function registerSystemIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SYSTEM_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.minimize();
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      if (win.isMaximized()) {
        win.unmaximize();
      } else {
        win.maximize();
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    win?.close();
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_IS_MAXIMIZED, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win?.isMaximized() ?? false;
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_PLATFORM, () => {
    return process.platform;
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_SET_ZOOM, (event, factor: unknown) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const numericFactor = typeof factor === 'number' && !isNaN(factor) ? factor : 1.0;
    const clampedFactor = Math.min(1.5, Math.max(0.75, numericFactor));
    if (win) {
      win.webContents.setZoomFactor(clampedFactor);
    }
    return clampedFactor;
  });

  ipcMain.handle(IPC_CHANNELS.SYSTEM_GET_ZOOM, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? win.webContents.getZoomFactor() : 1.0;
  });
}
