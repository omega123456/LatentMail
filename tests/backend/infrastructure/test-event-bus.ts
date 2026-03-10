/**
 * TestEventBus — singleton event bus used by test suites to observe IPC events
 * emitted by the main process via webContents.send().
 *
 * The bus is populated by a monkey-patch in test-main.ts that intercepts
 * hiddenWindow.webContents.send() and forwards every call here.
 */

import { DateTime } from 'luxon';

export interface EventRecord {
  channel: string;
  args: unknown[];
  timestamp: number;
}

export class TestEventBus {
  private static instance: TestEventBus;
  private history: EventRecord[] = [];
  private listeners: Map<string, Array<(args: unknown[]) => void>> = new Map();
  /**
   * Pending waiter cleanup callbacks — each callback clears the associated
   * timeout, removes the event listener, and rejects the promise. Called when
   * clear() is invoked so that no dangling timers or listeners remain.
   */
  private pendingWaiterCleanups: Array<() => void> = [];

  private constructor() {}

  static getInstance(): TestEventBus {
    if (!TestEventBus.instance) {
      TestEventBus.instance = new TestEventBus();
    }
    return TestEventBus.instance;
  }

  /**
   * Called by the webContents.send monkey-patch in test-main.ts.
   * Records the event and notifies any waiting listeners.
   */
  emit(channel: string, args: unknown[]): void {
    const record: EventRecord = { channel, args, timestamp: DateTime.now().toMillis() };
    this.history.push(record);

    const channelListeners = this.listeners.get(channel);
    if (channelListeners) {
      // Clone the array before iterating so that listeners removed during iteration are safe
      const listenersCopy = channelListeners.slice();
      for (const listener of listenersCopy) {
        listener(args);
      }
    }
  }

  /**
   * Wait for a specific channel event, with optional timeout and predicate.
   *
   * @param channel - The IPC channel name to wait for
   * @param options.timeout - Maximum wait time in ms (default 10000)
   * @param options.predicate - Optional predicate to filter which event counts
   * @returns Promise resolving with the matching event's args
   */
  waitFor(
    channel: string,
    options?: { timeout?: number; predicate?: (args: unknown[]) => boolean },
  ): Promise<unknown[]> {
    const timeoutMs = options?.timeout ?? 10_000;
    const predicate = options?.predicate;

    // Check history for an already-received matching event
    for (const record of this.history) {
      if (record.channel === channel) {
        if (!predicate || predicate(record.args)) {
          return Promise.resolve(record.args);
        }
      }
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        removeCleanup();
        removeListener();
        reject(new Error(`TestEventBus.waitFor timed out after ${timeoutMs}ms waiting for channel: ${channel}`));
      }, timeoutMs);

      const listener = (args: unknown[]): void => {
        if (settled) {
          return;
        }
        if (predicate && !predicate(args)) {
          return;
        }
        settled = true;
        clearTimeout(timeoutHandle);
        removeCleanup();
        removeListener();
        resolve(args);
      };

      const removeListener = (): void => {
        const channelListeners = this.listeners.get(channel);
        if (channelListeners) {
          const index = channelListeners.indexOf(listener);
          if (index !== -1) {
            channelListeners.splice(index, 1);
          }
          if (channelListeners.length === 0) {
            this.listeners.delete(channel);
          }
        }
      };

      // Cleanup callback: clears the timer, removes the listener, and rejects
      const cleanup = (): void => {
        clearTimeout(timeoutHandle);
        removeListener();
        reject(new Error('TestEventBus cleared'));
      };

      const removeCleanup = (): void => {
        const cleanupIndex = this.pendingWaiterCleanups.indexOf(cleanup);
        if (cleanupIndex !== -1) {
          this.pendingWaiterCleanups.splice(cleanupIndex, 1);
        }
      };

      this.pendingWaiterCleanups.push(cleanup);

      if (!this.listeners.has(channel)) {
        this.listeners.set(channel, []);
      }
      this.listeners.get(channel)!.push(listener);
    });
  }

  /**
   * Wait for N events on a channel, returning all their args arrays.
   *
   * @param channel - The IPC channel name to wait for
   * @param count - Number of events to collect
   * @param timeout - Maximum wait time in ms (default 10000)
   * @returns Promise resolving with an array of args arrays (one per event)
   */
  waitForN(channel: string, count: number, timeout: number = 10_000): Promise<unknown[][]> {
    const collected: unknown[][] = [];

    // Pre-fill from history
    for (const record of this.history) {
      if (record.channel === channel) {
        collected.push(record.args);
        if (collected.length >= count) {
          return Promise.resolve(collected.slice(0, count));
        }
      }
    }

    if (collected.length >= count) {
      return Promise.resolve(collected.slice(0, count));
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const timeoutHandle = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        removeCleanup();
        removeListener();
        reject(new Error(`TestEventBus.waitForN timed out after ${timeout}ms waiting for ${count} events on channel: ${channel} (got ${collected.length})`));
      }, timeout);

      const listener = (args: unknown[]): void => {
        if (settled) {
          return;
        }
        collected.push(args);
        if (collected.length >= count) {
          settled = true;
          clearTimeout(timeoutHandle);
          removeCleanup();
          removeListener();
          resolve(collected.slice(0, count));
        }
      };

      const removeListener = (): void => {
        const channelListeners = this.listeners.get(channel);
        if (channelListeners) {
          const index = channelListeners.indexOf(listener);
          if (index !== -1) {
            channelListeners.splice(index, 1);
          }
          if (channelListeners.length === 0) {
            this.listeners.delete(channel);
          }
        }
      };

      // Cleanup callback: clears the timer, removes the listener, and rejects
      const cleanup = (): void => {
        clearTimeout(timeoutHandle);
        removeListener();
        reject(new Error('TestEventBus cleared'));
      };

      const removeCleanup = (): void => {
        const cleanupIndex = this.pendingWaiterCleanups.indexOf(cleanup);
        if (cleanupIndex !== -1) {
          this.pendingWaiterCleanups.splice(cleanupIndex, 1);
        }
      };

      this.pendingWaiterCleanups.push(cleanup);

      if (!this.listeners.has(channel)) {
        this.listeners.set(channel, []);
      }
      this.listeners.get(channel)!.push(listener);
    });
  }

  /**
   * Get event history, optionally filtered by channel.
   *
   * @param channel - If provided, return only events on this channel
   * @returns Array of EventRecord objects
   */
  getHistory(channel?: string): EventRecord[] {
    if (channel === undefined) {
      return this.history.slice();
    }
    return this.history.filter((record) => record.channel === channel);
  }

  /**
   * Clear all history and pending listeners.
   * Any outstanding waitFor/waitForN promises are rejected immediately, and
   * their associated timeout handles are cleared so no dangling timers fire.
   * Called between test suites by the quiesce/restore lifecycle.
   */
  clear(): void {
    // Call all pending waiter cleanup callbacks before clearing state.
    // Each cleanup cancels the timeout, removes the listener, and rejects the promise.
    const cleanupsToCall = this.pendingWaiterCleanups.slice();
    this.pendingWaiterCleanups = [];
    for (const cleanup of cleanupsToCall) {
      cleanup();
    }

    this.history = [];
    this.listeners.clear();
  }
}
