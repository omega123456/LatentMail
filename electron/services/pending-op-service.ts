import log from 'electron-log/main';

/**
 * PendingOpService — tracks gmailMessageIds that are awaiting server-side
 * confirmation of a move/delete operation.
 *
 * Used to:
 *   - Block IMAP thread re-fetch in MAIL_FETCH_THREAD while ops are in-flight,
 *     preventing the server from re-contaminating the DB with the "deleted" message
 *     before the queue worker executes the IMAP delete.
 *   - Filter pending messages out of FETCH_THREAD results (response-level).
 *
 * Also owns the `threadBodyFetchAttempted` set (previously in mail-ipc.ts) so that
 * MailQueueService can clear it after queue confirmation without creating a circular
 * import cycle between mail-ipc.ts and mail-queue-service.ts.
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
   * Map keyed by "accountId:gmailThreadId" → Set of pending gmailMessageIds.
   * Synchronous Map operations are atomic in single-threaded Node.js.
   */
  private pendingOps = new Map<string, Set<string>>();

  /**
   * Set of "accountId:gmailThreadId" fetch keys for which an IMAP body fetch
   * has already been attempted. Guards against infinite re-fetch for orphan threads.
   * Lives here (not in mail-ipc.ts) so MailQueueService can clear entries after
   * queue confirmation without a circular import.
   */
  readonly threadBodyFetchAttempted = new Set<string>();

  private constructor() {}

  static getInstance(): PendingOpService {
    if (!PendingOpService.instance) {
      PendingOpService.instance = new PendingOpService();
    }
    return PendingOpService.instance;
  }

  /**
   * Register a list of gmailMessageIds as pending for the given thread.
   * Called by MAIL_MOVE and MAIL_DELETE IPC handlers after enqueuing.
   */
  register(accountId: number, gmailThreadId: string, gmailMessageIds: string[]): void {
    if (gmailMessageIds.length === 0) {
      return;
    }
    const key = this.makeKey(accountId, gmailThreadId);
    let set = this.pendingOps.get(key);
    if (!set) {
      set = new Set<string>();
      this.pendingOps.set(key, set);
    }
    for (const id of gmailMessageIds) {
      set.add(id);
    }
    log.debug(`[PendingOpService] Registered ${gmailMessageIds.length} pending message(s) for thread ${gmailThreadId} (account ${accountId})`);
  }

  /**
   * Clear specific gmailMessageIds from their thread's pending set.
   * If the thread's pending set becomes empty, removes the thread entry entirely.
   * Called by queue worker post-op handlers after IMAP operation completes or permanently fails.
   */
  clear(accountId: number, gmailThreadId: string, gmailMessageIds: string[]): void {
    const key = this.makeKey(accountId, gmailThreadId);
    const set = this.pendingOps.get(key);
    if (!set) {
      return;
    }
    for (const id of gmailMessageIds) {
      set.delete(id);
    }
    if (set.size === 0) {
      this.pendingOps.delete(key);
      log.debug(`[PendingOpService] Cleared all pending ops for thread ${gmailThreadId} (account ${accountId})`);
    } else {
      log.debug(`[PendingOpService] Cleared ${gmailMessageIds.length} message(s); ${set.size} still pending for thread ${gmailThreadId} (account ${accountId})`);
    }
  }

  /**
   * Returns true if the given thread has any pending operations for the account.
   * Used by MAIL_FETCH_THREAD to decide whether to block IMAP re-fetch.
   */
  hasPendingForThread(accountId: number, gmailThreadId: string): boolean {
    const key = this.makeKey(accountId, gmailThreadId);
    const set = this.pendingOps.get(key);
    return set != null && set.size > 0;
  }

  /**
   * Returns the set of pending gmailMessageIds for a thread.
   * Used by MAIL_FETCH_THREAD to filter pending messages from results.
   * Returns an empty Set if nothing is pending.
   */
  getPendingForThread(accountId: number, gmailThreadId: string): Set<string> {
    const key = this.makeKey(accountId, gmailThreadId);
    return this.pendingOps.get(key) ?? new Set<string>();
  }

  private makeKey(accountId: number, gmailThreadId: string): string {
    return `${accountId}:${gmailThreadId}`;
  }
}
