import log from 'electron-log/main';

/**
 * FolderLockManager — shared per-folder async lock manager.
 *
 * Both MailQueueService workers and SyncService acquire a lock before
 * operating on a folder. Locks have a configurable timeout to prevent
 * deadlocks. If a lock cannot be acquired within the timeout, the
 * waiting party receives a rejection (caller should retry).
 */
export class FolderLockManager {
  private static instance: FolderLockManager;

  /** Per-folder queue of resolve callbacks waiting to acquire the lock. */
  private locks = new Map<string, { queue: Array<() => void>; held: boolean }>();

  /** Default lock timeout in milliseconds (30 seconds). */
  private readonly lockTimeoutMs: number;

  private constructor(lockTimeoutMs = 30_000) {
    this.lockTimeoutMs = lockTimeoutMs;
  }

  static getInstance(): FolderLockManager {
    if (!FolderLockManager.instance) {
      FolderLockManager.instance = new FolderLockManager();
    }
    return FolderLockManager.instance;
  }

  /**
   * Acquire an exclusive lock on a folder.
   * Returns a release function that MUST be called when done.
   * Throws if the lock cannot be acquired within the timeout.
   */
  async acquire(folder: string): Promise<() => void> {
    let state = this.locks.get(folder);
    if (!state) {
      state = { queue: [], held: false };
      this.locks.set(folder, state);
    }

    if (!state.held) {
      // Lock is free — acquire immediately
      state.held = true;
      return this.createRelease(folder);
    }

    // Lock is held — wait in the queue with a timeout
    return new Promise<() => void>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Remove ourselves from the queue
        const idx = state!.queue.indexOf(onRelease);
        if (idx !== -1) state!.queue.splice(idx, 1);
        reject(new Error(`FolderLockManager: timeout acquiring lock on "${folder}" after ${this.lockTimeoutMs}ms`));
      }, this.lockTimeoutMs);

      const onRelease = () => {
        clearTimeout(timer);
        resolve(this.createRelease(folder));
      };

      state!.queue.push(onRelease);
    });
  }

  /**
   * Create a release function for the given folder.
   * When called, releases the lock and grants it to the next waiter (if any).
   */
  private createRelease(folder: string): () => void {
    let released = false;
    return () => {
      if (released) return; // Idempotent
      released = true;

      const state = this.locks.get(folder);
      if (!state) return;

      const next = state.queue.shift();
      if (next) {
        // Grant lock to next waiter
        next();
      } else {
        // No waiters — release the lock
        state.held = false;
      }
    };
  }

  /**
   * Check if a folder's lock is currently held.
   * Useful for diagnostics / settings page.
   */
  isLocked(folder: string): boolean {
    const state = this.locks.get(folder);
    return state?.held ?? false;
  }

  /**
   * Get the number of waiters for a folder's lock.
   */
  getWaiterCount(folder: string): number {
    const state = this.locks.get(folder);
    return state?.queue.length ?? 0;
  }
}
