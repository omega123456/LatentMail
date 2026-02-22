import log from 'electron-log/main';

/**
 * PendingOpService — tracks xGmMsgIds that are awaiting server-side
 * confirmation of a move/delete operation.
 *
 * Used to:
 *   - Block sync-thread enqueueing in MAIL_FETCH_THREAD while ops are in-flight,
 *     preventing the server from re-contaminating the DB with the "deleted" message
 *     before the queue worker executes the IMAP delete.
 *   - Filter pending messages out of FETCH_THREAD results (response-level).
 *
 * Cleared by queue worker post-op handlers after successful execution or
 * permanent failure.
 *
 * Ephemeral (in-memory only). App restart clears it; next sync corrects any
 * remaining DB inconsistencies.
 */
export class PendingOpService {
  private static instance: PendingOpService;

  /**
   * Map keyed by "accountId:xGmThrid" → Set of pending xGmMsgIds.
   * Synchronous Map operations are atomic in single-threaded Node.js.
   */
  private pendingOps = new Map<string, Set<string>>();

  private constructor() {}

  static getInstance(): PendingOpService {
    if (!PendingOpService.instance) {
      PendingOpService.instance = new PendingOpService();
    }
    return PendingOpService.instance;
  }

  /**
   * Register a list of xGmMsgIds as pending for the given thread.
   * Called by MAIL_MOVE and MAIL_DELETE IPC handlers after enqueuing.
   */
  register(accountId: number, xGmThrid: string, xGmMsgIds: string[]): void {
    if (xGmMsgIds.length === 0) {
      return;
    }
    const key = this.makeKey(accountId, xGmThrid);
    let set = this.pendingOps.get(key);
    if (!set) {
      set = new Set<string>();
      this.pendingOps.set(key, set);
    }
    for (const id of xGmMsgIds) {
      set.add(id);
    }
    log.debug(`[PendingOpService] Registered ${xGmMsgIds.length} pending message(s) for thread ${xGmThrid} (account ${accountId})`);
  }

  /**
   * Clear specific xGmMsgIds from their thread's pending set.
   * If the thread's pending set becomes empty, removes the thread entry entirely.
   * Called by queue worker post-op handlers after IMAP operation completes or permanently fails.
   */
  clear(accountId: number, xGmThrid: string, xGmMsgIds: string[]): void {
    const key = this.makeKey(accountId, xGmThrid);
    const set = this.pendingOps.get(key);
    if (!set) {
      return;
    }
    for (const id of xGmMsgIds) {
      set.delete(id);
    }
    if (set.size === 0) {
      this.pendingOps.delete(key);
      log.debug(`[PendingOpService] Cleared all pending ops for thread ${xGmThrid} (account ${accountId})`);
    } else {
      log.debug(`[PendingOpService] Cleared ${xGmMsgIds.length} message(s); ${set.size} still pending for thread ${xGmThrid} (account ${accountId})`);
    }
  }

  /**
   * Returns true if the given thread has any pending operations for the account.
   * Used by MAIL_FETCH_THREAD to decide whether to block IMAP re-fetch.
   */
  hasPendingForThread(accountId: number, xGmThrid: string): boolean {
    const key = this.makeKey(accountId, xGmThrid);
    const set = this.pendingOps.get(key);
    return set != null && set.size > 0;
  }

  /**
   * Returns the set of pending xGmMsgIds for a thread.
   * Used by MAIL_FETCH_THREAD to filter pending messages from results.
   * Returns an empty Set if nothing is pending.
   */
  getPendingForThread(accountId: number, xGmThrid: string): Set<string> {
    const key = this.makeKey(accountId, xGmThrid);
    return this.pendingOps.get(key) ?? new Set<string>();
  }

  private makeKey(accountId: number, xGmThrid: string): string {
    return `${accountId}:${xGmThrid}`;
  }
}
