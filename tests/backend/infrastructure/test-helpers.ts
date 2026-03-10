/**
 * test-helpers.ts — Core helpers for backend E2E tests.
 *
 * Provides:
 *   - callIpc()         — invoke a registered IPC handler directly (no wire)
 *   - getDatabase()     — access DatabaseService for direct DB assertions
 *   - waitForEvent()    — wait for a specific IPC event on TestEventBus
 */

import { ipcHandlerMap, hiddenWindow } from '../test-main';
import { DatabaseService } from '../../../electron/services/database-service';
import { TestEventBus } from './test-event-bus';

/**
 * Invoke an IPC handler directly, bypassing the Electron wire protocol.
 *
 * The mock event passed to the handler includes the hidden window's webContents
 * as `sender`, matching what production handlers receive when invoked from the
 * renderer.
 *
 * @param channel - The IPC channel name (must be registered via ipcMain.handle)
 * @param args - Arguments to pass to the handler (same as what the renderer would send)
 * @returns Whatever the handler returns (typically IpcResponse<T>)
 */
export async function callIpc(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipcHandlerMap.get(channel);
  if (!handler) {
    throw new Error(`No IPC handler registered for channel: ${channel}`);
  }
  // Pass a minimal mock IpcMainInvokeEvent — most handlers only use sender (if at all)
  const fakeEvent = { sender: hiddenWindow ? hiddenWindow.webContents : null };
  return handler(fakeEvent, ...args);
}

/**
 * Get direct access to the DatabaseService singleton for assertions.
 * Use database.getDatabase() to run raw SQL queries in tests.
 */
export function getDatabase(): DatabaseService {
  return DatabaseService.getInstance();
}

/**
 * Wait for a specific IPC event to arrive on the TestEventBus.
 *
 * @param channel - The channel name to listen for
 * @param options.timeout - Timeout in ms (default 10000)
 * @param options.predicate - Optional filter function
 * @returns Promise resolving with the event's args array
 */
export function waitForEvent(
  channel: string,
  options?: { timeout?: number; predicate?: (args: unknown[]) => boolean },
): Promise<unknown[]> {
  return TestEventBus.getInstance().waitFor(channel, options);
}

/**
 * Re-export ipcHandlerMap for advanced consumers (e.g. suite-level assertions
 * that need to inspect registered channels).
 */
export { ipcHandlerMap };
