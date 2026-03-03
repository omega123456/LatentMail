import { ipcMain } from 'electron';
import { IPC_CHANNELS, ipcSuccess } from './ipc-channels';
import { SyncQueueBridge } from '../services/sync-queue-bridge';

/**
 * Register IPC handlers for sync state queries.
 * Currently exposes a single invoke channel that returns the current pause state,
 * allowing the renderer to hydrate its UI on startup before any push event arrives.
 */
export function registerSyncIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.SYNC_GET_PAUSED, () => {
    const isPaused = SyncQueueBridge.getInstance().isPaused();
    return ipcSuccess({ paused: isPaused });
  });
}
