import { ipcMain } from 'electron';
import { IPC_CHANNELS, ipcSuccess } from './ipc-channels';
import { SyncQueueBridge } from '../services/sync-queue-bridge';

/**
 * Register IPC handlers for sync state queries and pause/resume control.
 * - get-paused: returns current pause state (for UI hydration on startup).
 * - pause / resume: same as CLI pause-sync / resume-sync; resume also handles sleep-stopped.
 */
export function registerSyncIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SYNC_GET_PAUSED, () => {
    const paused = SyncQueueBridge.getInstance().getPausedForUi();
    return ipcSuccess({ paused });
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_PAUSE, () => {
    const bridge = SyncQueueBridge.getInstance();
    bridge.pause();
    return ipcSuccess({ paused: true });
  });

  ipcMain.handle(IPC_CHANNELS.SYNC_RESUME, () => {
    const bridge = SyncQueueBridge.getInstance();
    if (bridge.isPaused()) {
      bridge.resume();
    } else if (bridge.getPausedForUi()) {
      bridge.startAfterWake();
    }
    return ipcSuccess({ paused: false });
  });
}
