/**
 * IPC Activity Tracker — tracks the most recent timestamp of mail:* and compose:* IPC calls.
 *
 * Used by EmbeddingService for idle detection: if recent IPC activity is detected
 * (within the last 30 seconds), incremental indexing is paused to avoid competing
 * with user-visible operations.
 *
 * Usage:
 *   - Call `patchIpcMainForActivityTracking()` once, before registering any IPC handlers.
 *   - Call `getLastIpcActivityTimestamp()` to read the current timestamp.
 *   - EmbeddingService imports `getLastIpcActivityTimestamp()` directly from this module.
 */

import { ipcMain } from 'electron';
import { LoggerService } from '../services/logger-service';

const log = LoggerService.getInstance();

/** Timestamp (ms) of the most recent mail:* or compose:* IPC invocation. */
let lastActivityTimestamp: number = 0;

/** Channels whose invocations count as user activity. */
const ACTIVITY_CHANNEL_PREFIXES = ['mail:', 'compose:'];

/**
 * Returns the timestamp of the most recent activity-tracked IPC call.
 */
export function getLastIpcActivityTimestamp(): number {
  return lastActivityTimestamp;
}

/**
 * Manually record IPC activity (for testing or explicit touch points).
 */
export function touchIpcActivity(): void {
  lastActivityTimestamp = Date.now();
}

/**
 * Patch ipcMain.handle so that any invocation on a `mail:*` or `compose:*` channel
 * automatically updates `lastActivityTimestamp`.
 *
 * Must be called BEFORE any IPC handlers are registered.
 * If called after, the already-registered handlers will NOT be wrapped.
 *
 * This is a one-time patch — calling it multiple times is a no-op.
 */
let patched = false;

export function patchIpcMainForActivityTracking(): void {
  if (patched) {
    return;
  }
  patched = true;

  const originalHandle = ipcMain.handle.bind(ipcMain) as typeof ipcMain.handle;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ipcMain as any).handle = (
    channel: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    listener: (...args: any[]) => any
  ): void => {
    const isActivityChannel = ACTIVITY_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix));

    if (isActivityChannel) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      originalHandle(channel, (...args: any[]) => {
        lastActivityTimestamp = Date.now();
        return listener(...args);
      });
    } else {
      originalHandle(channel, listener);
    }
  };

  log.debug('[IpcActivityTracker] ipcMain.handle patched for activity tracking on mail:* and compose:* channels');
}
