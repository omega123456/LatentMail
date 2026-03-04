import { BrowserWindow } from 'electron';
import { LoggerService } from './logger-service';
import * as fastq from 'fastq';

const log = LoggerService.getInstance();
import { randomUUID } from 'crypto';
import { ImapService } from './imap-service';
import { SmtpService } from './smtp-service';
import { DatabaseService } from './database-service';
import { FolderLockManager } from './folder-lock-manager';
import { PendingOpService } from './pending-op-service';
import { SyncService, ALL_MAIL_PATH } from './sync-service';
import { TrayService } from './tray-service';
import { buildDraftMime } from './draft-mime';
import { executeFetchOlder } from './fetch-older-handler';
import { formatParticipant, formatParticipantList } from '../utils/format-participant';
import { IPC_EVENTS } from '../ipc/ipc-channels';
import { BodyPrefetchService } from './body-prefetch-service';
import { EmbeddingService } from './embedding-service';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueOperationType =
  | 'draft-create'
  | 'draft-update'
  | 'send'
  | 'move'
  | 'flag'
  | 'delete'
  | 'delete-label'
  | 'add-labels'
  | 'remove-labels'
  | 'sync-folder'
  | 'sync-thread'
  | 'sync-allmail'
  | 'fetch-older'
  | 'body-fetch';

export type QueueItemStatus = 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface DraftPayload {
  subject: string;
  to: string;
  cc?: string;
  bcc?: string;
  htmlBody?: string;
  textBody?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{ filename: string; data: string; mimeType: string }>;
}

export interface DraftUpdatePayload extends DraftPayload {
  /** queueId of the original draft-create operation (used to resolve server IDs). */
  originalQueueId?: string;
  /** Server draft's X-GM-MSGID (alternative to originalQueueId for drafts opened from folder). */
  serverDraftXGmMsgId?: string;
}

export interface SendPayload {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  html?: string;
  text?: string;
  inReplyTo?: string;
  references?: string;
  attachments?: Array<{ filename: string; content: string; contentType: string }>;
  /** queueId of the draft being sent (optional; for draft cleanup via in-memory mapping). */
  originalQueueId?: string;
  /** Server draft's X-GM-MSGID (optional; for draft cleanup when queueId mapping unavailable). */
  serverDraftXGmMsgId?: string;
}

export interface MovePayload {
  xGmMsgIds: string[];
  sourceFolder?: string;
  sourceFolders?: string[];
  targetFolder: string;
  /** Metadata for DB/pending-op cleanup and renderer refresh. */
  emailMeta?: Array<{ xGmMsgId: string; xGmThrid: string }>;
  /** Runtime-only UID map built at execution time (not persisted). */
  runtimeResolvedByFolder?: Record<string, number[]>;
}

export interface FlagPayload {
  xGmMsgIds: string[];
  flag: string;
  value: boolean;
  /** Preferred source folder context (optional). */
  folder?: string;
  /** Runtime-only UID map built at execution time (not persisted). */
  runtimeResolvedByFolder?: Record<string, number[]>;
}

export interface DeletePayload {
  xGmMsgIds: string[];
  folder: string;
  /** Metadata for DB/pending-op cleanup and renderer refresh. */
  emailMeta?: Array<{ xGmMsgId: string; xGmThrid: string }>;
  /** Runtime-only resolved UID list built at execution time (not persisted). */
  runtimeResolvedUids?: number[];
}

export interface AddLabelsPayload {
  /** X-GM-MSGID values of the messages to label. */
  xGmMsgIds: string[];
  /** gmailLabelId values of the target label folders. */
  targetLabels: string[];
  /** Thread ID — used for DB updates and folder-updated event. */
  threadId: string;
  /**
   * Pre-resolved source folder + UID for each message (resolved at enqueue time).
   * { xGmMsgId, sourceFolder, uid }
   */
  resolvedEmails: Array<{ xGmMsgId: string; sourceFolder: string; uid: number }>;
}

export interface RemoveLabelsPayload {
  /** X-GM-MSGID values of the messages to unlabel. */
  xGmMsgIds: string[];
  /** gmailLabelId values of the label folders to remove from. */
  targetLabels: string[];
  /** Thread ID — used for DB updates and folder-updated event. */
  threadId: string;
  /**
   * Pre-resolved UID per label folder per message (resolved at enqueue time).
   * { xGmMsgId, labelFolder, uid }
   */
  resolvedEmails: Array<{ xGmMsgId: string; labelFolder: string; uid: number }>;
}

export interface SyncFolderPayload {
  /** IMAP folder path to sync (e.g. 'INBOX', '[Gmail]/Sent Mail'). */
  folder: string;
  /** Whether this is an initial sync (affects fetch limit and date range). */
  isInitial: boolean;
  /** ISO date string for incremental fetch scope. */
  sinceDate: string;
  /** Whether to show desktop notifications for new emails found (true for IDLE-triggered syncs). */
  showNotifications: boolean;
}

export interface SyncThreadPayload {
  /** Gmail thread ID (xGmThrid) to fetch bodies for. */
  xGmThrid: string;
  /** Whether to bypass body-exists check and force a fresh fetch. */
  forceFromServer: boolean;
}

export interface SyncAllMailPayload {
  /** Whether this is an initial sync (no prior All Mail folder_state). */
  isInitial: boolean;
  /** ISO date string for date-based fallback fetch scope. */
  sinceDate: string;
}

export interface FetchOlderPayload {
  /** IMAP folder path (e.g. 'INBOX', '[Gmail]/Sent Mail'). */
  folder: string;
  /** ISO date string — fetch emails before this date. */
  beforeDate: string;
  /** Max number of emails to fetch. */
  limit: number;
}

export interface DeleteLabelPayload {
  /** The IMAP mailbox path / Gmail label ID to delete (e.g. "MyCustomLabel"). */
  gmailLabelId: string;
}

export interface BodyFetchPayload {
  /**
   * Batch of emails whose bodies should be fetched from IMAP.
   * accountId is on QueueItem.accountId — not duplicated here.
   */
  emails: Array<{ xGmMsgId: string; xGmThrid: string }>;
}

export type QueuePayload =
  | DraftPayload
  | DraftUpdatePayload
  | SendPayload
  | MovePayload
  | FlagPayload
  | DeletePayload
  | DeleteLabelPayload
  | AddLabelsPayload
  | RemoveLabelsPayload
  | SyncFolderPayload
  | SyncThreadPayload
  | SyncAllMailPayload
  | FetchOlderPayload
  | BodyFetchPayload;

export interface ServerIds {
  xGmMsgId: string;
  xGmThrid: string;
  imapUid: number;
  imapUidValidity: number | null;
}

export interface QueueItem {
  queueId: string;
  accountId: number;
  type: QueueOperationType;
  payload: QueuePayload;
  status: QueueItemStatus;
  createdAt: string;
  completedAt?: string;
  retryCount: number;
  error?: string;
  result?: ServerIds | null;
  description: string;
  /** Dedup key for sync operations; prevents duplicate sync items from being enqueued. */
  dedupKey?: string;
}

/** Serialisable snapshot of a QueueItem sent to the renderer. */
export type QueueItemSnapshot = Omit<QueueItem, 'payload'>;

/** Payload for the mail:folder-updated push event. */
export interface MailFolderUpdatedPayload {
  accountId: number;
  folders: string[];
  reason: 'move' | 'delete' | 'flag' | 'send' | 'draft-create' | 'draft-update' | 'filter' | 'sync' | 'add-labels' | 'remove-labels';
  changeType?: 'new_messages' | 'flag_changes' | 'deletions' | 'mixed';
  count?: number;
}

/** Payload for the mail:fetch-older-done push event (success or error). */
export interface MailFetchOlderDonePayload {
  queueId: string;
  accountId: number;
  folderId: string;
  threads?: Array<Record<string, unknown>>;
  hasMore?: boolean;
  nextBeforeDate?: string | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

type ErrorCategory = 'transient' | 'permanent' | 'auth';

function classifyError(err: unknown): ErrorCategory {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();

  // Auth errors
  if (lower.includes('invalid_grant') || lower.includes('token revoked')) return 'auth';
  if (lower.includes('401') || lower.includes('unauthorized')) return 'auth';

  // Permanent IMAP errors
  if (/\bBAD\b/.test(msg)) return 'permanent';
  if (lower.includes('550 user unknown') || lower.includes('553 invalid')) return 'permanent';
  if (lower.includes('invalid recipient') || lower.includes('mailbox not found')) return 'permanent';

  // Everything else treated as transient (network, timeouts, etc.)
  return 'transient';
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GMAIL_DRAFTS_FOLDER = '[Gmail]/Drafts';
const GMAIL_SENT_FOLDER = '[Gmail]/Sent Mail';
const GMAIL_STARRED_FOLDER = '[Gmail]/Starred';
const POST_OP_FETCH_LIMIT = 5;
const MAX_RETRIES = 10;
const BACKOFF_BASE_MS = 2_000;
const BACKOFF_CAP_MS = 60_000;

function backoffDelay(retryCount: number): number {
  return Math.min(BACKOFF_BASE_MS * Math.pow(2, retryCount), BACKOFF_CAP_MS);
}

// ---------------------------------------------------------------------------
// MailQueueService
// ---------------------------------------------------------------------------

export class MailQueueService {
  private static instance: MailQueueService;

  /** Per-account fastq instances (concurrency 1 each). */
  private queues = new Map<number, fastq.queueAsPromised<QueueItem>>();

  /** All items by queueId for lookup / status reporting. */
  private items = new Map<string, QueueItem>();

  /** queueId → server IDs (populated after draft-create completes). */
  private queueIdToServerIds = new Map<string, ServerIds>();

  /** Retry timers for delayed re-enqueue. */
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  /** Per-account paused state (e.g. auth failure). */
  private pausedAccounts = new Set<number>();

  /**
   * Active dedup keys for sync operations.
   * Maps dedupKey → queueId for items that are pending or processing.
   * Allows enqueue() to skip duplicate sync items.
   */
  private activeDedupKeys = new Map<string, string>();

  private constructor() {}

  static getInstance(): MailQueueService {
    if (!MailQueueService.instance) {
      MailQueueService.instance = new MailQueueService();
    }
    return MailQueueService.instance;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Enqueue a mail operation. Returns the queueId immediately.
   * The caller can track the operation via `queue:update` events keyed by queueId.
   *
   * @param dedupKey  Optional dedup key (for sync operations). If an item with the same
   *                  key is already pending or processing, the enqueue is skipped and the
   *                  existing item's queueId is returned.
   */
  enqueue(
    accountId: number,
    type: QueueOperationType,
    payload: QueuePayload,
    description: string,
    providedQueueId?: string,
    dedupKey?: string,
  ): string {
    // Deduplication: if a matching item is already active, return its id without re-enqueueing.
    if (dedupKey) {
      const existingId = this.activeDedupKeys.get(dedupKey);
      if (existingId) {
        const existingItem = this.items.get(existingId);
        if (existingItem && (existingItem.status === 'pending' || existingItem.status === 'processing')) {
          log.debug(`[MailQueue] Dedup: skipping ${type} (dedupKey=${dedupKey}) — already queued as ${existingId}`);
          return existingId;
        }
      }
    }

    const queueId = providedQueueId || randomUUID();

    const item: QueueItem = {
      queueId,
      accountId,
      type,
      payload,
      status: 'pending',
      createdAt: new Date().toISOString(),
      retryCount: 0,
      description,
      dedupKey,
    };

    this.items.set(queueId, item);

    if (dedupKey) {
      this.activeDedupKeys.set(dedupKey, queueId);
    }

    this.emitUpdate(item);

    // Push into the account's fastq
    const q = this.getOrCreateQueue(accountId);
    q.push(item).catch((err) => {
      // fastq rejects only if the worker throws — already handled inside worker
      log.error(`[MailQueue] Unexpected rejection for ${queueId}:`, err);
    });

    log.info(`[MailQueue] Enqueued ${type} (${queueId}) for account ${accountId}: ${description}`);
    return queueId;
  }

  /** Get a snapshot of all queue items (for the settings UI). */
  getAllItems(): QueueItemSnapshot[] {
    return Array.from(this.items.values()).map(this.snapshot);
  }

  /** Get a single item snapshot by queueId. */
  getItem(queueId: string): QueueItemSnapshot | null {
    const item = this.items.get(queueId);
    return item ? this.snapshot(item) : null;
  }

  /** Get the server IDs resolved for a given queueId (draft-create result). */
  getServerIds(queueId: string): ServerIds | undefined {
    return this.queueIdToServerIds.get(queueId);
  }

  /** Retry all failed operations (or a specific one). */
  retryFailed(queueId?: string): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status !== 'failed') continue;
      if (queueId && item.queueId !== queueId) continue;

      // Reset and re-enqueue
      item.status = 'pending';
      item.error = undefined;
      item.retryCount = 0;
      item.completedAt = undefined;
      this.emitUpdate(item);

      const q = this.getOrCreateQueue(item.accountId);
      q.push(item).catch(() => {});
      count++;
    }
    return count;
  }

  /** Clear completed and cancelled items from the tracking map. */
  clearCompleted(): number {
    let count = 0;
    for (const [id, item] of this.items.entries()) {
      if (item.status === 'completed' || item.status === 'cancelled') {
        this.items.delete(id);
        count++;
      }
    }
    return count;
  }

  /**
   * Cancel all pending in-memory queue items for a given account.
   * Items currently being processed (`'processing'` status) are left to complete
   * or fail naturally — they cannot be safely interrupted mid-execution.
   * Returns the number of items cancelled.
   */
  cancelAllForAccount(accountId: number): number {
    let cancelledCount = 0;
    for (const item of this.items.values()) {
      if (item.accountId !== accountId) {
        continue;
      }
      if (item.status !== 'pending') {
        continue;
      }
      item.status = 'cancelled';
      item.error = undefined;
      item.completedAt = new Date().toISOString();
      this.cleanupDedupKey(item);
      this.emitUpdate(item);
      // Clear any pending retry timer
      const retryTimer = this.retryTimers.get(item.queueId);
      if (retryTimer) {
        clearTimeout(retryTimer);
        this.retryTimers.delete(item.queueId);
      }
      cancelledCount++;
    }
    if (cancelledCount > 0) {
      log.info(`[MailQueue] Cancelled ${cancelledCount} pending items for account ${accountId}`);
    }
    return cancelledCount;
  }

  /** Cancel a pending (not yet processing) operation. */
  cancel(queueId: string): boolean {
    const item = this.items.get(queueId);
    if (!item || item.status !== 'pending') return false;

    item.status = 'cancelled';
    item.error = undefined;
    item.completedAt = new Date().toISOString();
    this.cleanupDedupKey(item);
    this.emitUpdate(item);

    // Clear any pending retry timer
    const timer = this.retryTimers.get(queueId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(queueId);
    }

    return true;
  }

  /**
   * Remove the dedup key for a queue item after its lifecycle ends (completed, failed, cancelled).
   * Only removes the key if this item is still the registered owner (prevents races when an item
   * finishes after a newer item with the same key was already enqueued).
   */
  private cleanupDedupKey(item: QueueItem): void {
    if (!item.dedupKey) {
      return;
    }
    if (this.activeDedupKeys.get(item.dedupKey) === item.queueId) {
      this.activeDedupKeys.delete(item.dedupKey);
    }
  }

  /** Count of non-completed/non-failed items. */
  getPendingCount(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status === 'pending' || item.status === 'processing') count++;
    }
    return count;
  }

  /**
   * Fail queued operations that target a folder after UIDVALIDITY reset.
   * Returns the number of items marked as failed.
   */
  failOperationsForFolder(accountId: number, folder: string, reason: string): number {
    let failed = 0;
    for (const item of this.items.values()) {
      if (item.accountId !== accountId) {
        continue;
      }
      if (item.status !== 'pending') {
        continue;
      }
      if (!this.operationTouchesFolder(item, folder)) {
        continue;
      }

      item.status = 'failed';
      item.error = reason;
      item.completedAt = new Date().toISOString();
      this.emitUpdate(item);
      failed++;
    }
    return failed;
  }

  // -----------------------------------------------------------------------
  // Queue creation & worker
  // -----------------------------------------------------------------------

  private getOrCreateQueue(accountId: number): fastq.queueAsPromised<QueueItem> {
    let q = this.queues.get(accountId);
    if (!q) {
      q = fastq.promise(this.worker.bind(this), 1);
      this.queues.set(accountId, q);
    }
    return q;
  }

  /**
   * The queue worker — processes one item at a time per account.
   */
  private async worker(item: QueueItem): Promise<void> {
    // Skip if already cancelled/failed while waiting in queue
    if (item.status === 'failed') return;

    // Skip if account is paused (auth issue)
    if (this.pausedAccounts.has(item.accountId)) {
      this.scheduleRetry(item);
      return;
    }

    item.status = 'processing';
    this.emitUpdate(item);

    try {
      switch (item.type) {
        case 'draft-create':
          await this.processDraftCreate(item);
          break;
        case 'draft-update':
          await this.processDraftUpdate(item);
          break;
        case 'move':
          await this.processMove(item);
          break;
        case 'flag':
          await this.processFlag(item);
          break;
        case 'delete':
          await this.processDelete(item);
          break;
        case 'send':
          await this.processSend(item);
          break;
        case 'sync-folder':
          await this.processSyncFolder(item);
          break;
        case 'sync-thread':
          await this.processSyncThread(item);
          break;
        case 'sync-allmail':
          await this.processSyncAllMail(item);
          break;
        case 'fetch-older':
          await this.processFetchOlder(item);
          break;
        case 'add-labels':
          await this.processAddLabels(item);
          break;
        case 'remove-labels':
          await this.processRemoveLabels(item);
          break;
        case 'delete-label':
          await this.processDeleteLabel(item);
          break;
        case 'body-fetch':
          await this.processBodyFetch(item);
          break;
        default:
          throw new Error(`Unknown operation type: ${(item as QueueItem).type}`);
      }

      // Best-effort post-operation fetch: confirm server state and update local DB.
      // Failures are logged as warnings — the IMAP action already succeeded.
      // Sync and fetch-older operations handle their own post-processing inside their worker methods.
      if (item.type !== 'sync-folder' && item.type !== 'sync-thread' && item.type !== 'sync-allmail' && item.type !== 'fetch-older' && item.type !== 'add-labels' && item.type !== 'remove-labels' && item.type !== 'delete-label' && item.type !== 'body-fetch') {
        try {
          await this.postOpFetch(item);
        } catch (fetchErr) {
          log.warn(`[MailQueue] Post-op fetch failed for ${item.type} (${item.queueId}): ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
        }
      }

      // Success
      item.status = 'completed';
      item.completedAt = new Date().toISOString();
      this.cleanupDedupKey(item);
      this.emitUpdate(item);
      log.info(`[MailQueue] Completed ${item.type} (${item.queueId})`);
    } catch (err) {
      const category = classifyError(err);
      const errMsg = err instanceof Error ? err.message : String(err);

      log.warn(`[MailQueue] Failed ${item.type} (${item.queueId}): [${category}] ${errMsg}`);

      // Sync and fetch-older operations fail immediately on any error — no retry/backoff.
      // Rationale: network blips are transient; the next timer tick or user scroll re-enqueues.
      if (item.type === 'sync-folder' || item.type === 'sync-thread' || item.type === 'sync-allmail' || item.type === 'fetch-older' || item.type === 'add-labels' || item.type === 'remove-labels' || item.type === 'body-fetch') {
        item.status = 'failed';
        item.error = errMsg;
        item.completedAt = new Date().toISOString();
        this.cleanupDedupKey(item);
        this.emitUpdate(item);
        if (item.type === 'fetch-older') {
          const foPayload = item.payload as FetchOlderPayload;
          this.emitFetchOlderDone({
            queueId: item.queueId,
            accountId: item.accountId,
            folderId: foPayload.folder,
            error: errMsg,
          });
        }
        log.warn(`[MailQueue] ${item.type} failed immediately (${item.queueId}), no retry: ${errMsg}`);
        return;
      }

      // Fail immediately with no auto-retry: send (not idempotent) or delete/move/flag
      // when no messages found on server (retrying would never succeed). Same UX: mark
      // failed, show error toast, user can retry from queue settings if desired.
      const noMessagesFound = errMsg.includes('No messages found on server');
      const failImmediately =
        item.type === 'send' ||
        ((item.type === 'delete' || item.type === 'move' || item.type === 'flag') && noMessagesFound);

      if (failImmediately) {
        item.status = 'failed';
        item.error = errMsg;
        item.completedAt = new Date().toISOString();
        this.emitUpdate(item);
        if (item.type === 'move' || item.type === 'delete') {
          this.clearPendingOpsOnFailure(item);
        }
        const reason = item.type === 'send' ? 'not idempotent' : 'no messages found';
        log.error(`[MailQueue] ${item.type} failed (${item.queueId}), no auto-retry (${reason}): ${errMsg}`);
        return;
      }

      if (category === 'auth') {
        // Pause the account — all operations wait until unpaused
        this.pausedAccounts.add(item.accountId);
        log.warn(`[MailQueue] Paused account ${item.accountId} due to auth error`);
        this.scheduleRetry(item);
        return;
      }

      if (category === 'transient' && item.retryCount < MAX_RETRIES) {
        this.scheduleRetry(item);
        return;
      }

      // Permanent failure or max retries exceeded
      item.status = 'failed';
      item.error = errMsg;
      item.completedAt = new Date().toISOString();
      this.emitUpdate(item);
      log.error(`[MailQueue] Permanently failed ${item.type} (${item.queueId}) after ${item.retryCount} retries: ${errMsg}`);

      // On permanent failure for move/delete: still clear pending ops so the thread can
      // be re-fetched from IMAP. The server-side op failed, so the messages still exist
      // and will reappear correctly when the thread is next opened.
      if (item.type === 'move' || item.type === 'delete') {
        this.clearPendingOpsOnFailure(item);
      }
    }
  }

  /**
   * Clear pending ops for a failed move/delete operation.
   * This unblocks future sync-thread fetches so messages reappear correctly.
   * If emailMeta is unavailable, logs a warning — the next sync reconciliation
   * will correct any remaining inconsistencies.
   */
  private clearPendingOpsOnFailure(item: QueueItem): void {
    try {
      const pendingOpService = PendingOpService.getInstance();
      const payload = item.payload as MovePayload | DeletePayload;
      const emailMeta = payload.emailMeta ?? [];

      if (emailMeta.length === 0) {
        // No metadata available to target specific threads — pending ops will remain
        // until the next sync reconciliation or app restart clears them.
        log.warn(`[MailQueue] clearPendingOpsOnFailure (${item.queueId}): emailMeta is empty — pending ops not cleared; next sync will reconcile`);
        return;
      }

      const byThread = new Map<string, string[]>();
      for (const { xGmMsgId, xGmThrid } of emailMeta) {
        if (!xGmThrid) {
          continue;
        }
        if (!byThread.has(xGmThrid)) {
          byThread.set(xGmThrid, []);
        }
        byThread.get(xGmThrid)!.push(xGmMsgId);
      }

      for (const [xGmThrid, messageIds] of byThread) {
        pendingOpService.clear(item.accountId, xGmThrid, messageIds);
      }
    } catch (err) {
      log.warn(`[MailQueue] clearPendingOpsOnFailure failed for ${item.queueId}:`, err);
    }
  }

  // -----------------------------------------------------------------------
  // Draft-create worker
  // -----------------------------------------------------------------------

  private async processDraftCreate(item: QueueItem): Promise<void> {
    const payload = item.payload as DraftPayload;
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    const account = db.getAccountById(item.accountId);
    if (!account) throw new Error(`Account ${item.accountId} not found`);

    // Generate a stable Message-ID for this draft
    const domain = account.email.split('@')[1] || 'local';
    const draftMessageId = `<draft-${randomUUID()}@${domain}>`;

    // Build attachments from base64 payload
    const attachments: Array<{ filename: string; content: Buffer | string; contentType?: string }> = [];
    if (payload.attachments) {
      for (const att of payload.attachments) {
        if (att.data) {
          const buf = Buffer.from(att.data, 'base64');
          log.debug(`[MailQueue] draft-create (${item.queueId}): attachment "${att.filename}" decoded to ${buf.length} bytes`);
          if (buf.length === 0) {
            log.warn(`[MailQueue] draft-create (${item.queueId}): attachment "${att.filename}" decoded to 0 bytes — base64 data may be invalid`);
          }
          attachments.push({
            filename: att.filename,
            content: buf,
            contentType: att.mimeType || 'application/octet-stream',
          });
        } else {
          log.warn(`[MailQueue] draft-create (${item.queueId}): skipping attachment "${att.filename}" — data field is missing`);
        }
      }
    }

    // Build MIME
    const mimeBuffer = await buildDraftMime({
      from: `${account.displayName} <${account.email}>`,
      to: payload.to,
      cc: payload.cc || undefined,
      bcc: payload.bcc || undefined,
      subject: payload.subject,
      html: payload.htmlBody || undefined,
      text: payload.textBody || undefined,
      inReplyTo: payload.inReplyTo || undefined,
      references: payload.references || undefined,
      messageId: draftMessageId,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    // Acquire folder lock to coordinate with SyncService, then perform IMAP operations.
    // Lock ordering: FolderLockManager (app-level) → ImapFlow mailbox lock (protocol-level).
    // Both queue workers and SyncService follow this same order — no inversion deadlock risk.
    const release = await lockManager.acquire(GMAIL_DRAFTS_FOLDER, item.accountId);

    // Hoisted out of the try block so they are accessible after release() for All Mail UID resolution.
    let imapUid: number | null | undefined;
    let fetched: Awaited<ReturnType<typeof imapService.fetchMessageByUid>> | undefined;

    try {
      // APPEND to Gmail Drafts
      const appendResult = await imapService.appendDraft(String(item.accountId), mimeBuffer);
      imapUid = appendResult.uid;
      const imapUidValidity = appendResult.uidValidity;

      if (imapUid == null) {
        log.warn(`[MailQueue] draft-create (${item.queueId}): APPEND did not return UID — draft saved but not tracked locally`);
        // Still consider this a success — draft exists on server, will appear on next sync
        item.result = null;
        return;
      }

      // Fetch the newly appended message back from the server to get server-confirmed data
      fetched = await imapService.fetchMessageByUid(String(item.accountId), GMAIL_DRAFTS_FOLDER, imapUid);

      // Determine server IDs
      const xGmMsgId = fetched?.xGmMsgId || draftMessageId;
      const xGmThrid = fetched?.xGmThrid || draftMessageId;

      log.info(`[MailQueue] draft-create (${item.queueId}): thread assignment`, {
        hasInReplyTo: !!payload.inReplyTo,
        hasReferences: !!payload.references,
        inReplyTo: payload.inReplyTo,
        references: payload.references,
        fetchedXGmThrid: fetched?.xGmThrid,
        fetchedXGmMsgId: fetched?.xGmMsgId,
        newThreadCreated: fetched?.xGmThrid === fetched?.xGmMsgId,
        xGmThridSource: fetched?.xGmThrid ? 'server' : 'draftMessageId',
      });

      // Insert server-confirmed data into local DB
      db.upsertEmail({
        accountId: item.accountId,
        xGmMsgId,
        xGmThrid,
        folder: GMAIL_DRAFTS_FOLDER,
        folderUid: imapUid,
        fromAddress: account.email,
        fromName: account.displayName,
        toAddresses: payload.to || '',
        ccAddresses: payload.cc || '',
        bccAddresses: payload.bcc || '',
        subject: payload.subject || '',
        textBody: fetched?.textBody || payload.textBody || '',
        htmlBody: fetched?.htmlBody || payload.htmlBody || '',
        date: fetched?.date || new Date().toISOString(),
        isRead: true,
        isStarred: false,
        isImportant: false,
        isDraft: fetched?.isDraft ?? true,
        snippet: (payload.textBody || '').substring(0, 100),
        hasAttachments: (payload.attachments?.length ?? 0) > 0,
        messageId: fetched?.messageId ?? draftMessageId,
      });

      // Upsert thread
      const existingThread = db.getThreadById(item.accountId, xGmThrid);

      log.info(`[MailQueue] draft-create (${item.queueId}): existingThread`, {
        xGmThrid,
        found: !!existingThread,
      });

      if (!existingThread) {
        db.upsertThread({
          accountId: item.accountId,
          xGmThrid,
          subject: payload.subject || '',
          lastMessageDate: new Date().toISOString(),
          participants: formatParticipant(
            account.email,
            typeof (account as Record<string, unknown>)['display_name'] === 'string'
              ? (account as Record<string, unknown>)['display_name'] as string
              : undefined
          ),
          messageCount: 1,
          snippet: (payload.textBody || '').substring(0, 100),
          isRead: true,
          isStarred: false,
        });
      }
      db.upsertThreadFolder(item.accountId, xGmThrid, GMAIL_DRAFTS_FOLDER);

      // Store server ID mapping
      const serverIds: ServerIds = { xGmMsgId, xGmThrid, imapUid, imapUidValidity };
      this.queueIdToServerIds.set(item.queueId, serverIds);
      item.result = serverIds;

      log.info(`[MailQueue] draft-create (${item.queueId}): uid=${imapUid}, msgId=${xGmMsgId}`);
    } finally {
      release();
    }

    // Resolve All Mail UID for the new draft after releasing the lock.
    // Skip if imapUid was null (early return path) or fetched returned no real xGmMsgId
    // (local draft-id fallback is not a real X-GM-MSGID that Gmail can look up in All Mail).
    if (imapUid != null && fetched?.xGmMsgId) {
      try {
        const uidMap = await imapService.resolveUidsByXGmMsgIdBatch(String(item.accountId), ALL_MAIL_PATH, [fetched.xGmMsgId]);
        db.writeAllMailFolderUids(item.accountId, uidMap);
      } catch (allMailUidErr) {
        log.warn(`[MailQueue] draft-create (${item.queueId}): failed to resolve All Mail UID (continuing):`, allMailUidErr);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Draft-update worker
  // -----------------------------------------------------------------------

  private async processDraftUpdate(item: QueueItem): Promise<void> {
    const payload = item.payload as DraftUpdatePayload;
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    // Resolve the server IDs via two paths:
    //   1. In-memory mapping (draft created this session)
    //   2. Local DB lookup by xGmMsgId (draft opened from server)
    let oldServerIds: ServerIds | undefined;

    // Path 1: Resolve via in-memory mapping (draft created in this session)
    if (payload.originalQueueId) {
      oldServerIds = this.queueIdToServerIds.get(payload.originalQueueId);
    }

    // Path 2: Resolve via DB lookup (draft opened from server, or mapping lost after restart)
    if (!oldServerIds && payload.serverDraftXGmMsgId) {
      const folderUids = db.getFolderUidsForEmail(item.accountId, payload.serverDraftXGmMsgId);
      const draftsEntry = folderUids.find(fu => fu.folder === GMAIL_DRAFTS_FOLDER);
      if (draftsEntry) {
        const oldEmail = db.getEmailByXGmMsgId(item.accountId, payload.serverDraftXGmMsgId);
        const xGmThrid = oldEmail ? String(oldEmail['xGmThrid'] || '') : '';
        // Look up stored UIDVALIDITY from folder_state so deleteDraftByUid can validate the UID.
        // Falls back to null (skip check) if no sync has occurred yet for this folder.
        const folderState = db.getFolderState(item.accountId, GMAIL_DRAFTS_FOLDER);
        const storedUidValidity = folderState ? Number(folderState.uidValidity) : null;
        oldServerIds = {
          xGmMsgId: payload.serverDraftXGmMsgId,
          xGmThrid,
          imapUid: draftsEntry.uid,
          imapUidValidity: storedUidValidity,
        };
      }
    }

    if (!oldServerIds) {
      // Fallback: treat as draft-create (mapping lost, e.g. after app restart)
      log.warn(`[MailQueue] draft-update (${item.queueId}): no server IDs for originalQueueId=${payload.originalQueueId} or serverDraftXGmMsgId=${payload.serverDraftXGmMsgId}, falling back to draft-create`);
      item.type = 'draft-create';
      await this.processDraftCreate(item);
      return;
    }

    const account = db.getAccountById(item.accountId);
    if (!account) throw new Error(`Account ${item.accountId} not found`);

    // Generate a new Message-ID for the updated draft
    const domain = account.email.split('@')[1] || 'local';
    const newMessageId = `<draft-${randomUUID()}@${domain}>`;

    // Build attachments
    const attachments: Array<{ filename: string; content: Buffer | string; contentType?: string }> = [];
    if (payload.attachments) {
      for (const att of payload.attachments) {
        if (att.data) {
          const buf = Buffer.from(att.data, 'base64');
          log.debug(`[MailQueue] draft-update (${item.queueId}): attachment "${att.filename}" decoded to ${buf.length} bytes`);
          if (buf.length === 0) {
            log.warn(`[MailQueue] draft-update (${item.queueId}): attachment "${att.filename}" decoded to 0 bytes — base64 data may be invalid`);
          }
          attachments.push({
            filename: att.filename,
            content: buf,
            contentType: att.mimeType || 'application/octet-stream',
          });
        } else {
          log.warn(`[MailQueue] draft-update (${item.queueId}): skipping attachment "${att.filename}" — data field is missing`);
        }
      }
    }

    // Build MIME
    const mimeBuffer = await buildDraftMime({
      from: `${account.displayName} <${account.email}>`,
      to: payload.to,
      cc: payload.cc || undefined,
      bcc: payload.bcc || undefined,
      subject: payload.subject,
      html: payload.htmlBody || undefined,
      text: payload.textBody || undefined,
      inReplyTo: payload.inReplyTo || undefined,
      references: payload.references || undefined,
      messageId: newMessageId,
      attachments: attachments.length > 0 ? attachments : undefined,
    });

    const release = await lockManager.acquire(GMAIL_DRAFTS_FOLDER, item.accountId);

    // Hoisted out of the try block so they are accessible after release() for All Mail UID resolution.
    let newUid: number | null | undefined;
    let fetched: Awaited<ReturnType<typeof imapService.fetchMessageByUid>> | undefined;

    try {
      // APPEND new version first (safe — no data loss if this fails)
      const appendResult = await imapService.appendDraft(String(item.accountId), mimeBuffer);
      newUid = appendResult.uid;
      const newUidValidity = appendResult.uidValidity;

      // Delete old draft from server (best-effort after successful append)
      try {
        await imapService.deleteDraftByUid(
          String(item.accountId),
          GMAIL_DRAFTS_FOLDER,
          oldServerIds.imapUid,
          oldServerIds.imapUidValidity,
        );

        // Remove the old draft email row and all its associations from the local DB.
        // A draft exists only in [Gmail]/Drafts, so once deleted from the server it
        // is a true orphan — removeEmailAndAssociations cleans up emails, email_folders,
        // thread_folders, and orphaned threads atomically.
        db.removeEmailAndAssociations(item.accountId, oldServerIds.xGmMsgId);
      } catch (delErr) {
        log.warn(`[MailQueue] draft-update (${item.queueId}): failed to delete old draft uid=${oldServerIds.imapUid} (continuing):`, delErr);
      }

      if (newUid == null) {
        log.warn(`[MailQueue] draft-update (${item.queueId}): APPEND did not return UID`);
        // Remove old mapping if it exists, set result null
        if (payload.originalQueueId) {
          this.queueIdToServerIds.delete(payload.originalQueueId);
        }
        item.result = null;
        return;
      }

      // Fetch the new message from server
      fetched = await imapService.fetchMessageByUid(String(item.accountId), GMAIL_DRAFTS_FOLDER, newUid);
      const xGmMsgId = fetched?.xGmMsgId || newMessageId;
      // Preserve the original thread ID to avoid creating a new thread (dedupe)
      const xGmThrid = fetched?.xGmThrid || oldServerIds.xGmThrid;

      // Insert new server-confirmed data into local DB
      db.upsertEmail({
        accountId: item.accountId,
        xGmMsgId,
        xGmThrid,
        folder: GMAIL_DRAFTS_FOLDER,
        folderUid: newUid,
        fromAddress: account.email,
        fromName: account.displayName,
        toAddresses: payload.to || '',
        ccAddresses: payload.cc || '',
        bccAddresses: payload.bcc || '',
        subject: payload.subject || '',
        textBody: fetched?.textBody || payload.textBody || '',
        htmlBody: fetched?.htmlBody || payload.htmlBody || '',
        date: fetched?.date || new Date().toISOString(),
        isRead: true,
        isStarred: false,
        isImportant: false,
        isDraft: fetched?.isDraft ?? true,
        snippet: (payload.textBody || '').substring(0, 100),
        hasAttachments: (payload.attachments?.length ?? 0) > 0,
        messageId: fetched?.messageId ?? newMessageId,
      });

      // Upsert thread
      const existingThread = db.getThreadById(item.accountId, xGmThrid);
      if (!existingThread) {
        db.upsertThread({
          accountId: item.accountId,
          xGmThrid,
          subject: payload.subject || '',
          lastMessageDate: new Date().toISOString(),
          participants: formatParticipant(
            account.email,
            typeof (account as Record<string, unknown>)['display_name'] === 'string'
              ? (account as Record<string, unknown>)['display_name'] as string
              : undefined
          ),
          messageCount: 1,
          snippet: (payload.textBody || '').substring(0, 100),
          isRead: true,
          isStarred: false,
        });
      }
      db.upsertThreadFolder(item.accountId, xGmThrid, GMAIL_DRAFTS_FOLDER);

      // Update server ID mapping (point the ORIGINAL queueId to the new server IDs)
      // Only update if originalQueueId was provided (draft created this session)
      const serverIds: ServerIds = { xGmMsgId, xGmThrid, imapUid: newUid, imapUidValidity: newUidValidity };
      if (payload.originalQueueId) {
        this.queueIdToServerIds.set(payload.originalQueueId, serverIds);
      }
      item.result = serverIds;

      log.info(`[MailQueue] draft-update (${item.queueId}): new uid=${newUid}, old uid=${oldServerIds.imapUid} deleted`);
    } finally {
      release();
    }

    // Resolve All Mail UID for the updated draft after releasing the lock.
    // Skip if newUid was null (early return path) or fetched returned no real xGmMsgId
    // (local draft-id fallback is not a real X-GM-MSGID that Gmail can look up in All Mail).
    // Note: when this method falls back to processDraftCreate(), the create path handles resolution.
    if (newUid != null && fetched?.xGmMsgId) {
      try {
        const uidMap = await imapService.resolveUidsByXGmMsgIdBatch(String(item.accountId), ALL_MAIL_PATH, [fetched.xGmMsgId]);
        db.writeAllMailFolderUids(item.accountId, uidMap);
      } catch (allMailUidErr) {
        log.warn(`[MailQueue] draft-update (${item.queueId}): failed to resolve All Mail UID (continuing):`, allMailUidErr);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Move worker
  // -----------------------------------------------------------------------

  private async processMove(item: QueueItem): Promise<void> {
    const payload = item.payload as MovePayload;
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    const sourceFolders = this.resolveSourceFoldersForMove(payload);
    if (sourceFolders.length === 0) {
      throw new Error(
        `move (${item.queueId}): no source folders resolved for ${payload.xGmMsgIds.join(', ')} — cannot perform IMAP move`
      );
    }
    const runtimeResolvedByFolder: Record<string, number[]> = {};

    const resolvedAny = new Set<string>();
    let movedCount = 0;

    for (const folder of sourceFolders) {
      const resolved = await imapService.resolveUidsByXGmMsgId(String(item.accountId), folder, payload.xGmMsgIds);
      const resolvedUids = Array.from(resolved.values());
      runtimeResolvedByFolder[folder] = resolvedUids;

      for (const xGmMsgId of resolved.keys()) {
        resolvedAny.add(xGmMsgId);
      }

      if (resolvedUids.length === 0) {
        continue;
      }

      const release = await lockManager.acquire(folder, item.accountId);
      try {
        await imapService.moveMessages(String(item.accountId), folder, resolvedUids, payload.targetFolder);
      } finally {
        release();
      }
      movedCount += resolvedUids.length;
    }

    payload.runtimeResolvedByFolder = runtimeResolvedByFolder;
    const unresolvedCount = payload.xGmMsgIds.filter((id) => !resolvedAny.has(id)).length;
    const requestedCount = payload.xGmMsgIds.length;

    if (movedCount === 0 && requestedCount > 0) {
      const errMsg = 'No messages found on server — they may have been deleted or moved';
      log.warn(`[MailQueue] move (${item.queueId}): no resolvable UIDs in source folder(s)`);
      throw new Error(errMsg);
    }

    this.applyResolutionWarning(item, unresolvedCount, requestedCount);

    const emailCount = payload.emailMeta?.length ?? payload.xGmMsgIds.length;
    log.info(`[MailQueue] move (${item.queueId}): requested=${requestedCount}, moved=${movedCount}, emails=${emailCount}, target=${payload.targetFolder}`);
  }

  // -----------------------------------------------------------------------
  // Flag worker
  // -----------------------------------------------------------------------

  private async processFlag(item: QueueItem): Promise<void> {
    const payload = item.payload as FlagPayload;
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    // Build IMAP flags object
    const imapFlags: { read?: boolean; starred?: boolean } = {};
    if (payload.flag === 'read') imapFlags.read = payload.value;
    if (payload.flag === 'starred') imapFlags.starred = payload.value;

    if (Object.keys(imapFlags).length === 0) {
      log.info(`[MailQueue] flag (${item.queueId}): ${payload.flag} has no IMAP mapping; local optimistic state retained`);
      return;
    }

    const byFolder = new Map<string, Set<string>>();
    for (const xGmMsgId of payload.xGmMsgIds) {
      const folders = payload.folder ? [payload.folder] : db.getFoldersForEmail(item.accountId, xGmMsgId);
      for (const folder of folders) {
        if (!byFolder.has(folder)) {
          byFolder.set(folder, new Set<string>());
        }
        byFolder.get(folder)!.add(xGmMsgId);
      }
    }

    const runtimeResolvedByFolder: Record<string, number[]> = {};
    const resolvedAny = new Set<string>();

    const folders = Array.from(byFolder.keys()).sort();
    for (const folder of folders) {
      const ids = Array.from(byFolder.get(folder) ?? []);
      if (ids.length === 0) {
        continue;
      }

      const resolved = await imapService.resolveUidsByXGmMsgId(String(item.accountId), folder, ids);
      const uids = Array.from(resolved.values());
      runtimeResolvedByFolder[folder] = uids;

      for (const id of resolved.keys()) {
        resolvedAny.add(id);
      }

      if (uids.length === 0) {
        continue;
      }

      const release = await lockManager.acquire(folder, item.accountId);
      try {
        await imapService.setFlags(String(item.accountId), folder, uids, imapFlags);
      } finally {
        release();
      }
    }

    payload.runtimeResolvedByFolder = runtimeResolvedByFolder;
    const unresolvedCount = payload.xGmMsgIds.filter((id) => !resolvedAny.has(id)).length;
    const totalCount = payload.xGmMsgIds.length;

    if (totalCount > 0 && unresolvedCount >= totalCount) {
      const errMsg = 'No messages found on server — they may have been deleted or moved';
      log.warn(`[MailQueue] flag (${item.queueId}): no resolvable UIDs for ${payload.flag}`);
      throw new Error(errMsg);
    }

    this.applyResolutionWarning(item, unresolvedCount, totalCount);

    log.info(`[MailQueue] flag (${item.queueId}): ${payload.flag}=${payload.value} on ${payload.xGmMsgIds.length} emails`);
  }

  // -----------------------------------------------------------------------
  // Delete worker
  // -----------------------------------------------------------------------

  private async processDelete(item: QueueItem): Promise<void> {
    const payload = item.payload as DeletePayload;
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();
    const db = DatabaseService.getInstance();

    const folder = payload.folder;
    const trashFolder = db.getTrashFolder(item.accountId);

    // Defensive guard: if somehow a delete targeting Trash ends up in the queue
    // (e.g. a race condition between the UI guard and queue enqueue), treat it as
    // a no-op success. The IPC handler already returns early for Trash folders,
    // so this should never fire in practice, but prevents a IMAP MOVE Trash→Trash
    // error if it does.
    if (folder === trashFolder) {
      log.info(`[MailQueue] delete (${item.queueId}): folder is Trash — no-op (permanent delete not supported)`);
      return;
    }

    const resolved = await imapService.resolveUidsByXGmMsgId(
      String(item.accountId),
      folder,
      payload.xGmMsgIds,
    );
    const uids = Array.from(resolved.values());
    payload.runtimeResolvedUids = uids;

    const unresolvedCount = payload.xGmMsgIds.length - uids.length;
    const totalCount = payload.xGmMsgIds.length;

    if (uids.length === 0) {
      const errMsg = 'No messages found on server — they may have been deleted or moved';
      log.warn(`[MailQueue] delete (${item.queueId}): no resolvable UIDs in ${folder}`);
      throw new Error(errMsg);
    }

    this.applyResolutionWarning(item, unresolvedCount, totalCount);

    // Perform soft-delete: move messages to Trash via IMAP (with folder lock).
    // Permanent IMAP EXPUNGE is not performed here.
    const release = await lockManager.acquire(folder, item.accountId);
    try {
      await imapService.deleteMessages(String(item.accountId), folder, uids, trashFolder);
    } finally {
      release();
    }

    // DB was already updated optimistically by the IPC handler.
    // No further DB updates needed here.

    const emailCount = payload.emailMeta?.length ?? payload.xGmMsgIds.length;
    log.info(`[MailQueue] delete (${item.queueId}): moved ${emailCount} email(s) from ${folder} to Trash`);
  }

  // -----------------------------------------------------------------------
  // Delete-label worker
  // -----------------------------------------------------------------------

  /**
   * Execute the IMAP mailbox deletion for a queued delete-label operation.
   * The local DB has already been cleaned up optimistically by the IPC handler;
   * this method only performs the server-side IMAP deletion.
   * ImapService.deleteMailbox already acquires FolderLockManager('__label_mgmt', accountId)
   * internally — no additional locking is needed here.
   */
  private async processDeleteLabel(item: QueueItem): Promise<void> {
    const payload = item.payload as DeleteLabelPayload;
    const imapService = ImapService.getInstance();

    try {
      await imapService.deleteMailbox(String(item.accountId), payload.gmailLabelId);
      log.info(`[MailQueue] delete-label (${item.queueId}): deleted IMAP mailbox "${payload.gmailLabelId}" for account ${item.accountId}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const lower = message.toLowerCase();
      // "Mailbox not found" (or equivalent) means the mailbox is already gone — treat as success.
      // This handles the case where a previous attempt partially succeeded or the label was
      // deleted via another client. The desired end state (mailbox absent) is already achieved.
      if (lower.includes('mailbox not found') || lower.includes('mailbox doesn') || lower.includes('no such mailbox') || lower.includes('nonexistent mailbox')) {
        log.info(`[MailQueue] delete-label (${item.queueId}): mailbox "${payload.gmailLabelId}" already absent on server — treating as success`);
        return;
      }
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // Body-fetch worker
  // -----------------------------------------------------------------------

  /**
   * Process a body-fetch queue item.
   * Delegates to BodyPrefetchService.fetchAndStoreBodies() which resolves UIDs,
   * fetches bodies from [Gmail]/All Mail, and updates the DB.
   */
  private async processBodyFetch(item: QueueItem): Promise<void> {
    const payload = item.payload as BodyFetchPayload;
    const prefetchService = BodyPrefetchService.getInstance();
    await prefetchService.fetchAndStoreBodies(item.accountId, payload.emails);

    // Schedule incremental vector indexing after bodies are stored.
    // EmbeddingService will wait for user idle before starting the indexing run.
    // The incrementalScheduled guard in EmbeddingService prevents duplicate scheduling
    // when multiple body-fetch items complete in rapid succession.
    try {
      const embeddingService = EmbeddingService.getInstance();
      embeddingService.scheduleIncrementalIndex();
    } catch {
      // EmbeddingService may not be initialized (e.g. sqlite-vec unavailable) — skip silently
    }
  }

  private resolveSourceFoldersForMove(
    payload: MovePayload,
  ): string[] {
    if (payload.sourceFolder) {
      return [payload.sourceFolder];
    }
    if (payload.sourceFolders && payload.sourceFolders.length > 0) {
      return payload.sourceFolders;
    }
    return [];
  }

  private applyResolutionWarning(item: QueueItem, unresolvedCount: number, totalCount: number): void {
    // Empty payload — nothing to resolve; treat as clean success (no warning on completed item).
    if (totalCount <= 0) {
      item.error = undefined;
      log.warn(`[MailQueue] ${item.type} (${item.queueId}): payload contained no message IDs — operation was a no-op`);
      return;
    }

    // All resolved — clean success.
    if (unresolvedCount <= 0) {
      item.error = undefined;
      return;
    }

    // Some or all unresolved — set a warning string (item.status will still be 'completed').
    if (unresolvedCount >= totalCount) {
      item.error = 'Completed with warnings: No messages found on server — they may have been deleted or moved';
      return;
    }

    item.error = `Completed with warnings: ${unresolvedCount} of ${totalCount} messages not found on server`;
  }

  private operationTouchesFolder(item: QueueItem, folder: string): boolean {
    if (item.type === 'move') {
      const payload = item.payload as MovePayload;
      if (payload.sourceFolder) {
        return payload.sourceFolder === folder;
      }
      return (payload.sourceFolders ?? []).includes(folder);
    }
    if (item.type === 'delete') {
      const payload = item.payload as DeletePayload;
      return payload.folder === folder;
    }
    if (item.type === 'flag') {
      const payload = item.payload as FlagPayload;
      if (payload.folder) {
        return payload.folder === folder;
      }
      const runtimeFolders = payload.runtimeResolvedByFolder ? Object.keys(payload.runtimeResolvedByFolder) : [];
      if (runtimeFolders.length === 0) {
        return true;
      }
      return runtimeFolders.includes(folder);
    }
    if (item.type === 'sync-folder') {
      const payload = item.payload as SyncFolderPayload;
      return payload.folder === folder;
    }
    if (item.type === 'fetch-older') {
      const payload = item.payload as FetchOlderPayload;
      return payload.folder === folder;
    }
    return false;
  }

  // -----------------------------------------------------------------------
  // Send worker
  // -----------------------------------------------------------------------

  private async processSend(item: QueueItem): Promise<void> {
    const payload = item.payload as SendPayload;
    const smtpService = SmtpService.getInstance();
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    const account = db.getAccountById(item.accountId);
    if (!account) throw new Error(`Account ${item.accountId} not found`);

    // Build attachments for nodemailer format.
    // Content arrives as base64 string from the renderer — decode to Buffer
    // so nodemailer handles it as binary data, not UTF-8 text.
    // Filter out entries with missing content to avoid sending 0-byte attachments.
    const attachments = payload.attachments
      ?.filter((att) => {
        if (!att.content) {
          log.warn(`[MailQueue] send (${item.queueId}): skipping attachment "${att.filename}" — content is missing or empty`);
          return false;
        }
        return true;
      })
      .map((att) => {
        const buf = Buffer.from(att.content, 'base64');
        log.debug(`[MailQueue] send (${item.queueId}): attachment "${att.filename}" decoded to ${buf.length} bytes`);
        if (buf.length === 0) {
          log.warn(`[MailQueue] send (${item.queueId}): attachment "${att.filename}" decoded to 0 bytes — base64 data may be invalid`);
        }
        return {
          filename: att.filename,
          content: buf,
          contentType: att.contentType || 'application/octet-stream',
        };
      });

    // Send the email via SMTP
    const result = await smtpService.sendEmail(String(item.accountId), {
      to: payload.to,
      cc: payload.cc || undefined,
      bcc: payload.bcc || undefined,
      subject: payload.subject,
      text: payload.text || undefined,
      html: payload.html || undefined,
      inReplyTo: payload.inReplyTo || undefined,
      references: payload.references || undefined,
      attachments: attachments && attachments.length > 0 ? attachments : undefined,
    });

    log.info(`[MailQueue] send (${item.queueId}): SMTP success, messageId=${result.messageId}`);

    // After successful SMTP send, delete the server draft if one exists.
    // Two resolution paths:
    //   1. originalQueueId → in-memory queueIdToServerIds mapping (draft created this session)
    //   2. serverDraftXGmMsgId → resolve UID from local DB (draft opened from server)
    await this.cleanupDraftAfterSend(item, payload);

    // Sent message appears in Sent folder on next sync — no local DB insert needed.
    item.result = null;
  }

  /**
   * Best-effort draft cleanup after a successful send.
   * Resolves the draft's server UID via:
   *   1. In-memory queueIdToServerIds mapping (draft created this session)
   *   2. Local DB lookup by xGmMsgId (draft opened from server / mapping lost)
   * Then deletes from IMAP and cleans up local DB associations.
   */
  private async cleanupDraftAfterSend(item: QueueItem, payload: SendPayload): Promise<void> {
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    // Path 1: Resolve via in-memory mapping (draft created in this session)
    let draftXGmMsgId: string | undefined;
    let draftImapUid: number | undefined;
    let draftUidValidity: number | null | undefined;

    if (payload.originalQueueId) {
      const serverIds = this.queueIdToServerIds.get(payload.originalQueueId);
      if (serverIds) {
        draftXGmMsgId = serverIds.xGmMsgId;
        draftImapUid = serverIds.imapUid;
        draftUidValidity = serverIds.imapUidValidity;
      }
    }

    // Path 2: Resolve via DB lookup (draft opened from server, or mapping lost after restart)
    if (!draftImapUid && payload.serverDraftXGmMsgId) {
      draftXGmMsgId = payload.serverDraftXGmMsgId;
      const folderUids = db.getFolderUidsForEmail(item.accountId, payload.serverDraftXGmMsgId);
      const draftsEntry = folderUids.find(fu => fu.folder === GMAIL_DRAFTS_FOLDER);
      if (draftsEntry) {
        draftImapUid = draftsEntry.uid;
        // No stored UIDVALIDITY in this path — pass undefined to skip the check
        draftUidValidity = undefined;
      }
    }

    if (!draftImapUid || !draftXGmMsgId) {
      if (payload.originalQueueId || payload.serverDraftXGmMsgId) {
        log.info(`[MailQueue] send (${item.queueId}): Could not resolve draft UID for cleanup — draft may persist until next sync`);
      }
      // Clean up mapping even if we couldn't delete
      if (payload.originalQueueId) {
        this.queueIdToServerIds.delete(payload.originalQueueId);
      }
      return;
    }

    const release = await lockManager.acquire(GMAIL_DRAFTS_FOLDER, item.accountId);
    try {
      // Delete the draft from the server via IMAP
      try {
        await imapService.deleteDraftByUid(
          String(item.accountId),
          GMAIL_DRAFTS_FOLDER,
          draftImapUid,
          draftUidValidity ?? null,
        );
        log.info(`[MailQueue] send (${item.queueId}): Deleted server draft uid=${draftImapUid}`);
      } catch (delErr) {
        // Best-effort: draft will be cleaned up by next sync
        log.warn(`[MailQueue] send (${item.queueId}): Failed to delete server draft uid=${draftImapUid}:`, delErr);
      }

      // Remove draft from local DB
      try {
        db.removeEmailFolderAssociation(item.accountId, draftXGmMsgId, GMAIL_DRAFTS_FOLDER);

        const draftEmail = db.getEmailByXGmMsgId(item.accountId, draftXGmMsgId);
        if (draftEmail) {
          const threadId = String(draftEmail['xGmThrid'] || '');
          if (threadId && !db.threadHasEmailsInFolder(item.accountId, threadId, GMAIL_DRAFTS_FOLDER)) {
            db.removeThreadFolderAssociation(item.accountId, threadId, GMAIL_DRAFTS_FOLDER);
          }
        }
      } catch (dbErr) {
        log.warn(`[MailQueue] send (${item.queueId}): Failed to clean up draft from local DB:`, dbErr);
      }
    } finally {
      release();
    }

    // Clean up the queueId→serverIds mapping
    if (payload.originalQueueId) {
      this.queueIdToServerIds.delete(payload.originalQueueId);
    }
  }

  // -----------------------------------------------------------------------
  // Sync-folder worker
  // -----------------------------------------------------------------------

  /**
   * Process a sync-folder queue item.
   * Delegates IMAP fetch + DB upsert + reconciliation to SyncService.syncFolder()
   * (Pattern A: lock → fetch → upsert → reconcile → release lock).
   * After success, emits MAIL_FOLDER_UPDATED so the renderer reloads the folder.
   * After UIDVALIDITY reset, fails pending operations targeting the affected folder.
   */
  private async processSyncFolder(item: QueueItem): Promise<void> {
    const payload = item.payload as SyncFolderPayload;
    const syncService = SyncService.getInstance();

    const result = await syncService.syncFolder(
      String(item.accountId),
      payload.folder,
      payload.isInitial,
      new Date(payload.sinceDate),
      payload.showNotifications,
    );

    // UIDVALIDITY reset: fail any pending operations targeting this folder.
    // syncFolder() has already wiped folder data in the DB.
    if (result.uidValidityChanged) {
      const invalidated = this.failOperationsForFolder(
        item.accountId,
        payload.folder,
        'UIDVALIDITY changed for folder — UIDs are no longer valid',
      );
      if (invalidated > 0) {
        log.warn(`[MailQueue] processSyncFolder: Invalidated ${invalidated} queued operation(s) for ${payload.folder} after UIDVALIDITY reset`);
      }
    }

    // Emit folder-updated event so renderer reloads the folder list and thread list.
    if (result.folderChanged) {
      this.emitFolderUpdated(item.accountId, [payload.folder], 'sync', result.changeType, result.changeCount);
    }

    // After IDLE-triggered INBOX sync with new messages, enqueue body-fetch for freshly-synced
    // emails so their bodies are pre-loaded before the user clicks the thread.
    // Guard: only for IDLE-triggered INBOX syncs (showNotifications === true) with new messages.
    if (
      payload.folder === 'INBOX' &&
      payload.showNotifications === true &&
      result.folderChanged &&
      (result.changeType === 'new_messages' || result.changeType === 'mixed')
    ) {
      try {
        const prefetchService = BodyPrefetchService.getInstance();
        // Use sinceMinutes: 5 to target only emails synced in the last 5 minutes.
        const emailsNeedingBodies = prefetchService.getEmailsNeedingBodies(item.accountId, 50, 5);
        if (emailsNeedingBodies.length > 0) {
          const dedupKey = `body-fetch-idle:${item.accountId}`;
          this.enqueue(
            item.accountId,
            'body-fetch',
            { emails: emailsNeedingBodies.map((email) => ({ xGmMsgId: email.xGmMsgId, xGmThrid: email.xGmThrid })) },
            `Prefetch ${emailsNeedingBodies.length} new email bodies`,
            undefined,
            dedupKey,
          );
          log.debug(`[MailQueue] processSyncFolder: enqueued IDLE body-fetch for account ${item.accountId} (${emailsNeedingBodies.length} emails)`);
        }
      } catch (idleBodyFetchErr) {
        log.warn(`[MailQueue] processSyncFolder: failed to enqueue IDLE body-fetch for account ${item.accountId}:`, idleBodyFetchErr);
      }
    }
  }

  // -----------------------------------------------------------------------
  // Sync-allmail worker
  // -----------------------------------------------------------------------

  /**
   * Process a sync-allmail queue item.
   * Delegates to SyncService.syncAllMail() which fetches from [Gmail]/All Mail,
   * maps labels to folders, reconciles email_folders, and returns affected folders.
   * Emits MAIL_FOLDER_UPDATED for all affected folders.
   */
  private async processSyncAllMail(item: QueueItem): Promise<void> {
    const payload = item.payload as SyncAllMailPayload;
    const syncService = SyncService.getInstance();
    const db = DatabaseService.getInstance();

    // Build known mailbox paths set for label validation.
    // We need the full mailbox list (including All Mail path for the filter).
    let knownPaths: Set<string>;
    try {
      const mailboxes = await syncService.getMailboxesForSync(String(item.accountId));
      knownPaths = new Set(mailboxes.map((mb) => mb.path));
    } catch (err) {
      log.warn(`[MailQueue] processSyncAllMail: failed to fetch mailbox list, proceeding with empty set:`, err);
      knownPaths = new Set();
    }

    const affectedFolders = await syncService.syncAllMail(
      String(item.accountId),
      payload.isInitial,
      new Date(payload.sinceDate),
      knownPaths,
    );

    // Emit folder-updated for all affected folders
    if (affectedFolders.size > 0) {
      this.emitFolderUpdated(item.accountId, Array.from(affectedFolders), 'sync', 'mixed');
    }

    // Enqueue body-fetch after sync completes so we're working against freshly-upserted rows.
    try {
      const prefetchService = BodyPrefetchService.getInstance();
      const emailsNeedingBodies = prefetchService.getEmailsNeedingBodies(item.accountId, 50);
      if (emailsNeedingBodies.length > 0) {
        const dedupKey = `body-fetch:${item.accountId}`;
        this.enqueue(
          item.accountId,
          'body-fetch',
          { emails: emailsNeedingBodies.map((email) => ({ xGmMsgId: email.xGmMsgId, xGmThrid: email.xGmThrid })) },
          `Prefetch ${emailsNeedingBodies.length} email bodies`,
          undefined,
          dedupKey,
        );
        log.debug(`[MailQueue] processSyncAllMail: enqueued body-fetch for account ${item.accountId} (${emailsNeedingBodies.length} emails)`);
      }
    } catch (bodyFetchErr) {
      log.warn(`[MailQueue] processSyncAllMail: failed to enqueue body-fetch for account ${item.accountId}:`, bodyFetchErr);
    }
  }

  // -----------------------------------------------------------------------
  // Sync-thread worker
  // -----------------------------------------------------------------------

  /**
   * Process a sync-thread queue item.
   * Delegates IMAP thread fetch + DB body upsert + stale-message reconciliation
   * to SyncService.syncThread(). After success, emits MAIL_THREAD_REFRESH so
   * the renderer re-loads the thread with freshly-fetched bodies.
   */
  private async processSyncThread(item: QueueItem): Promise<void> {
    const payload = item.payload as SyncThreadPayload;
    const syncService = SyncService.getInstance();

    await syncService.syncThread(String(item.accountId), payload.xGmThrid);

    // Emit thread-refresh so the renderer re-loads the thread with bodies.
    this.emitThreadRefresh(item.accountId, payload.xGmThrid, 'sync');
  }

  // -----------------------------------------------------------------------
  // Fetch-older worker (scroll-to-load)
  // -----------------------------------------------------------------------

  /**
   * Process a fetch-older queue item.
   * Runs inside folder lock; calls shared executeFetchOlder, then emits
   * MAIL_FETCH_OLDER_DONE so the renderer can append threads and update cursor.
   */
  private async processFetchOlder(item: QueueItem): Promise<void> {
    const payload = item.payload as FetchOlderPayload;
    const lockManager = FolderLockManager.getInstance();

    const release = await lockManager.acquire(payload.folder, item.accountId);
    try {
      const result = await executeFetchOlder(
        item.accountId,
        payload.folder,
        payload.beforeDate,
        payload.limit
      );
      this.emitFetchOlderDone({
        queueId: item.queueId,
        accountId: item.accountId,
        folderId: payload.folder,
        threads: result.threads,
        hasMore: result.hasMore,
        nextBeforeDate: result.nextBeforeDate,
      });
    } finally {
      release();
    }
  }

  // -----------------------------------------------------------------------
  // Post-operation fetch — confirm server state & update local DB
  // -----------------------------------------------------------------------

  /**
   * Dispatch post-op fetch based on operation type.
   * Called after the processX method succeeds, before marking as completed.
   * Best-effort: failures are caught by the caller and logged as warnings.
   */
  private async postOpFetch(item: QueueItem): Promise<void> {
    switch (item.type) {
      case 'move':
        await this.postOpFetchMove(item);
        break;
      case 'delete':
        await this.postOpFetchDelete(item);
        break;
      case 'flag':
        await this.postOpFetchFlag(item);
        break;
      case 'send':
        await this.postOpFetchSend(item);
        break;
      case 'draft-create':
        // draft-create already fetches + upserts inline; just emit folder-updated
        this.emitFolderUpdated(item.accountId, [GMAIL_DRAFTS_FOLDER], 'draft-create', 'mixed');
        break;
      case 'draft-update':
        // draft-update already fetches + upserts inline; just emit folder-updated
        this.emitFolderUpdated(item.accountId, [GMAIL_DRAFTS_FOLDER], 'draft-update', 'mixed');
        break;
    }
  }

  /**
   * Post-op fetch for move:
   * 1. Re-fetch resolved UIDs from source folders to confirm removal (UID-not-found is expected)
   * 2. Fetch latest N from target folder to pick up newly-moved messages (UIDs change after MOVE)
   * 3. Clear PendingOpService entries, recompute thread metadata, emit thread-refresh
   */
  private async postOpFetchMove(item: QueueItem): Promise<void> {
    const payload = item.payload as MovePayload;
    const sourceFolders = payload.runtimeResolvedByFolder ? Object.keys(payload.runtimeResolvedByFolder) : [];
    const allFolders = [...new Set([...sourceFolders, payload.targetFolder])];

    // Re-fetch resolved UIDs from source folders to confirm removal.
    // UID-not-found is expected (confirms the move succeeded); any still-present
    // UIDs get upserted to keep local DB in sync.
    if (payload.runtimeResolvedByFolder && Object.keys(payload.runtimeResolvedByFolder).length > 0) {
      await this.fetchUidsAndUpsert(item.accountId, payload.runtimeResolvedByFolder);
    }

    // Fetch latest N from target folder to pick up newly-moved messages
    await this.fetchLatestAndUpsert(item.accountId, payload.targetFolder);

    // --- Post-confirmation cleanup ---
    const pendingOpService = PendingOpService.getInstance();
    const db = DatabaseService.getInstance();
    const affectedThreadIds = new Set<string>();

    if (payload.emailMeta && payload.emailMeta.length > 0) {
      // Group by thread so we clear pending ops and recompute per-thread
      const byThread = new Map<string, string[]>();
      for (const { xGmMsgId, xGmThrid } of payload.emailMeta) {
        if (!xGmThrid) {
          continue;
        }
        if (!byThread.has(xGmThrid)) {
          byThread.set(xGmThrid, []);
        }
        byThread.get(xGmThrid)!.push(xGmMsgId);
        affectedThreadIds.add(xGmThrid);
      }

      for (const [xGmThrid, messageIds] of byThread) {
        // 1. Clear pending ops for these messages
        pendingOpService.clear(item.accountId, xGmThrid, messageIds);

        // 2. Recompute thread metadata from actual DB state
        try {
          db.recomputeThreadMetadata(item.accountId, xGmThrid);
        } catch (recomputeErr) {
          log.warn(`[MailQueue] postOpFetchMove: recomputeThreadMetadata failed for thread ${xGmThrid}:`, recomputeErr);
        }

        // 3. Emit thread-refresh so renderer re-loads if this thread is selected
        this.emitThreadRefresh(item.accountId, xGmThrid, 'move');
      }
    }

    await this.updateFolderStateForFolders(item.accountId, allFolders);
    this.emitFolderUpdated(item.accountId, allFolders, 'move', 'mixed');
    TrayService.getInstance().refreshUnreadCount();
  }

  /**
   * Post-op fetch for delete: fetch latest N from Trash to pick up newly-trashed
   * messages, then clear PendingOpService entries and recompute thread metadata.
   * All deletes are soft-deletes (move to Trash) — permanent EXPUNGE is never used.
   */
  private async postOpFetchDelete(item: QueueItem): Promise<void> {
    const payload = item.payload as DeletePayload;
    const db = DatabaseService.getInstance();
    const trashFolder = db.getTrashFolder(item.accountId);

    // Fetch latest N from Trash to pick up newly-trashed messages
    await this.fetchLatestAndUpsert(item.accountId, trashFolder);
    await this.updateFolderStateForFolders(item.accountId, [payload.folder, trashFolder]);
    this.emitFolderUpdated(item.accountId, [payload.folder, trashFolder], 'delete', 'deletions');

    TrayService.getInstance().refreshUnreadCount();

    // --- Post-confirmation cleanup ---
    if (payload.emailMeta && payload.emailMeta.length > 0) {
      const pendingOpService = PendingOpService.getInstance();
      const db = DatabaseService.getInstance();

      const byThread = new Map<string, string[]>();
      for (const { xGmMsgId, xGmThrid } of payload.emailMeta) {
        if (!xGmThrid) {
          continue;
        }
        if (!byThread.has(xGmThrid)) {
          byThread.set(xGmThrid, []);
        }
        byThread.get(xGmThrid)!.push(xGmMsgId);
      }

      for (const [xGmThrid, messageIds] of byThread) {
        // 1. Clear pending ops for these messages
        pendingOpService.clear(item.accountId, xGmThrid, messageIds);

        // 2. Recompute thread metadata from actual DB state
        try {
          db.recomputeThreadMetadata(item.accountId, xGmThrid);
        } catch (recomputeErr) {
          log.warn(`[MailQueue] postOpFetchDelete: recomputeThreadMetadata failed for thread ${xGmThrid}:`, recomputeErr);
        }

        // 3. Emit thread-refresh so renderer re-loads if this thread is selected
        this.emitThreadRefresh(item.accountId, xGmThrid, 'delete');
      }
    }
  }

  /**
   * Post-op fetch for flag: re-fetch each affected UID per folder to confirm flag state.
   * For starred flag operations, also fetch/reconcile [Gmail]/Starred to keep folder
   * membership in sync (star adds the message to the folder, unstar removes it).
   */
  private async postOpFetchFlag(item: QueueItem): Promise<void> {
    const payload = item.payload as FlagPayload;
    const byFolder = payload.runtimeResolvedByFolder;
    if (!byFolder || Object.keys(byFolder).length === 0) return;

    const folders = Object.keys(byFolder);
    await this.fetchUidsAndUpsert(item.accountId, byFolder);

    // Starred flag operations affect [Gmail]/Starred folder membership.
    // Star → message appears in the folder; Unstar → message disappears.
    if (payload.flag === 'starred') {
      try {
        if (payload.value) {
          // Starring: fetch latest from [Gmail]/Starred to pick up newly-starred messages
          await this.fetchLatestAndUpsert(item.accountId, GMAIL_STARRED_FOLDER);
        } else {
          // Unstarring: reconcile [Gmail]/Starred to remove stale associations
          await this.reconcileFolder(item.accountId, GMAIL_STARRED_FOLDER);
        }
      } catch (err) {
        log.warn(`[MailQueue] Post-op Starred folder sync failed (${item.queueId}): ${err instanceof Error ? err.message : String(err)}`);
      }

      // Include [Gmail]/Starred in the changed folders
      if (!folders.includes(GMAIL_STARRED_FOLDER)) {
        folders.push(GMAIL_STARRED_FOLDER);
      }
    }

    await this.updateFolderStateForFolders(item.accountId, folders);
    this.emitFolderUpdated(item.accountId, folders, 'flag', 'flag_changes');
    if (payload.flag === 'read') {
      TrayService.getInstance().refreshUnreadCount();
    }
  }

  /**
   * Post-op fetch for send: fetch latest N from Sent Mail to pick up the sent message.
   */
  private async postOpFetchSend(item: QueueItem): Promise<void> {
    await this.fetchLatestAndUpsert(item.accountId, GMAIL_SENT_FOLDER);
    await this.updateFolderStateForFolders(item.accountId, [GMAIL_SENT_FOLDER, GMAIL_DRAFTS_FOLDER]);

    // Also emit for Drafts in case a draft was cleaned up
    this.emitFolderUpdated(item.accountId, [GMAIL_SENT_FOLDER, GMAIL_DRAFTS_FOLDER], 'send', 'mixed');
  }

  /**
   * Fetch latest N messages from a folder and upsert into local DB.
   * Acquires folder lock during the IMAP fetch, releases before DB upsert.
   */
  private async fetchLatestAndUpsert(accountId: number, folder: string): Promise<void> {
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    let emails: Awaited<ReturnType<typeof imapService.fetchEmails>>;

    // Acquire folder lock only for the IMAP fetch, release before DB upsert
    const release = await lockManager.acquire(folder, accountId);
    try {
      emails = await imapService.fetchEmails(String(accountId), folder, { limit: POST_OP_FETCH_LIMIT });
    } finally {
      release();
    }

    await this.upsertFetchedEmails(accountId, folder, emails);
  }

  /**
   * Fetch specific UIDs from each folder and upsert into local DB.
   * Acquires folder locks in lexicographic order; releases each after its IMAP fetch.
   */
  private async fetchUidsAndUpsert(
    accountId: number,
    byFolder: Record<string, number[]>,
  ): Promise<void> {
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();

    // Acquire locks in lexicographic order to prevent deadlocks
    const folders = Object.keys(byFolder).sort();

    for (const folder of folders) {
      const uids = byFolder[folder];
      if (!uids || uids.length === 0) continue;

      const fetchedEmails: Array<Awaited<ReturnType<typeof imapService.fetchMessageByUid>>> = [];

      const release = await lockManager.acquire(folder, accountId);
      try {
        for (const uid of uids) {
          try {
            const email = await imapService.fetchMessageByUid(String(accountId), folder, uid);
            if (email) {
              fetchedEmails.push(email);
            }
          } catch (uidErr) {
            // UID may no longer exist (e.g. message was moved/expunged) — log and skip
            log.warn(`[MailQueue] Post-op fetch: UID ${uid} not found in ${folder}: ${uidErr instanceof Error ? uidErr.message : String(uidErr)}`);
          }
        }
      } finally {
        release();
      }

      // Upsert fetched emails outside the lock
      const validEmails = fetchedEmails.filter((e): e is NonNullable<typeof e> => e != null);
      if (validEmails.length > 0) {
        await this.upsertFetchedEmails(accountId, folder, validEmails);
      }
    }
  }

  /**
   * Targeted folder reconciliation: compare local email_folders UIDs against the
   * server's complete UID set and remove stale associations. Used after unstar to
   * clean [Gmail]/Starred promptly without waiting for a full account sync.
   *
   * Fetches UIDs under the folder lock, then delegates DB cleanup to
   * SyncService.reconcileFolderWithServerUids() (which is lock-free DB work).
   */
  private async reconcileFolder(accountId: number, folder: string): Promise<void> {
    const imapService = ImapService.getInstance();
    const lockManager = FolderLockManager.getInstance();
    const syncService = SyncService.getInstance();

    let serverUids: number[];
    const release = await lockManager.acquire(folder, accountId);
    try {
      serverUids = await imapService.fetchFolderUids(String(accountId), folder);
    } finally {
      release();
    }

    const { staleCount: removalCount } = await syncService.reconcileFolderWithServerUids(String(accountId), folder, serverUids);
    if (removalCount > 0) {
      this.emitFolderUpdated(accountId, [folder], 'sync', 'deletions', removalCount);
    }
  }

  /**
   * Upsert an array of fetched emails into the local DB, including thread associations.
   * Replicates the upsert pattern from SyncService.syncAccount().
   */
  private async upsertFetchedEmails(
    accountId: number,
    folder: string,
    emails: Array<{
      uid: number;
      xGmMsgId: string;
      xGmThrid: string;
      fromAddress: string;
      fromName: string;
      toAddresses: string;
      ccAddresses: string;
      bccAddresses: string;
      subject: string;
      textBody: string;
      htmlBody: string;
      date: string;
      isRead: boolean;
      isStarred: boolean;
      isImportant: boolean;
      isDraft: boolean;
      snippet: string;
      size: number;
      hasAttachments: boolean;
      labels: string;
      messageId?: string;
    }>,
  ): Promise<void> {
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();

    // Group emails by thread
    const threadMap = new Map<string, typeof emails>();
    for (const email of emails) {
      const threadId = email.xGmThrid || email.xGmMsgId;
      if (!threadMap.has(threadId)) {
        threadMap.set(threadId, []);
      }
      threadMap.get(threadId)!.push(email);
    }

    // Upsert each email
    for (const email of emails) {
      db.upsertEmail({
        accountId,
        xGmMsgId: email.xGmMsgId,
        xGmThrid: email.xGmThrid,
        folder,
        folderUid: email.uid,
        fromAddress: email.fromAddress,
        fromName: email.fromName,
        toAddresses: email.toAddresses,
        ccAddresses: email.ccAddresses,
        bccAddresses: email.bccAddresses,
        subject: email.subject,
        textBody: email.textBody,
        htmlBody: email.htmlBody,
        date: email.date,
        isRead: email.isRead,
        isStarred: email.isStarred,
        isImportant: email.isImportant,
        isDraft: email.isDraft,
        snippet: email.snippet,
        size: email.size,
        hasAttachments: email.hasAttachments,
        labels: email.labels,
        messageId: email.messageId,
      });
    }

    // Upsert threads (dedupe emails by xGmMsgId)
    for (const [threadId, threadEmails] of threadMap) {
      const uniqueEmails = [...new Map(threadEmails.map(e => [e.xGmMsgId, e])).values()];

      const latest = uniqueEmails.reduce((a, b) =>
        new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
      );
      const participants = formatParticipantList(uniqueEmails);
      const allRead = uniqueEmails.every(e => e.isRead);
      const anyStarred = uniqueEmails.some(e => e.isStarred);

      db.upsertThread({
        accountId,
        xGmThrid: threadId,
        subject: latest.subject,
        lastMessageDate: latest.date,
        participants,
        messageCount: uniqueEmails.length,
        snippet: latest.snippet,
        isRead: allRead,
        isStarred: anyStarred,
      });

      db.upsertThreadFolder(accountId, threadId, folder);
    }

    // Resolve All Mail UIDs for the upserted emails (skip if fetched from All Mail itself,
    // as those already have UIDs from the upsert above).
    if (folder !== ALL_MAIL_PATH) {
      try {
        const xGmMsgIds = emails.map((email) => email.xGmMsgId).filter(Boolean);
        if (xGmMsgIds.length > 0) {
          const uidMap = await imapService.resolveUidsByXGmMsgIdBatch(String(accountId), ALL_MAIL_PATH, xGmMsgIds);
          db.writeAllMailFolderUids(accountId, uidMap);
        }
      } catch (allMailUidErr) {
        log.warn(`[MailQueue] upsertFetchedEmails: failed to resolve All Mail UIDs for ${folder} (account ${accountId}) (continuing):`, allMailUidErr);
      }
    }
  }

  private async updateFolderStateForFolders(accountId: number, folders: string[]): Promise<void> {
    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();

    const uniqueFolders = Array.from(new Set(folders));
    for (const folder of uniqueFolders) {
      try {
        const status = await imapService.getMailboxStatus(String(accountId), folder);
        // Only update uidValidity and condstoreSupported — do NOT advance highestModseq.
        // The modseq must only advance inside the sync path (fetchChangedSince) so that
        // the next incremental sync does not skip messages that arrived between our last
        // sync and this queue op.
        db.updateFolderStateNonModseq(
          accountId,
          folder,
          status.uidValidity,
          status.condstoreSupported,
        );
      } catch (err) {
        log.warn(`[MailQueue] Failed to update folder_state for ${folder} (account ${accountId}):`, err);
      }
    }
  }

  /**
   * Emit mail:folder-updated event to all renderer windows.
   */
  private emitFolderUpdated(
    accountId: number,
    folders: string[],
    reason: MailFolderUpdatedPayload['reason'],
    changeType: MailFolderUpdatedPayload['changeType'] = 'mixed',
    count?: number,
  ): void {
    const payload: MailFolderUpdatedPayload = { accountId, folders, reason, changeType, count };
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.MAIL_FOLDER_UPDATED, payload);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }

  /**
   * Emit mail:thread-refresh event to all renderer windows.
   * Signals the renderer to re-load the specified thread from the now-clean DB.
   */
  private emitThreadRefresh(
    accountId: number,
    xGmThrid: string,
    action: 'move' | 'delete' | 'sync',
  ): void {
    const payload = { accountId, xGmThrid, action };
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.MAIL_THREAD_REFRESH, payload);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }

  /**
   * Emit mail:fetch-older-done event to all renderer windows.
   * Success: includes threads, hasMore, nextBeforeDate. Error: includes error string.
   */
  private emitFetchOlderDone(payload: MailFetchOlderDonePayload): void {
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.MAIL_FETCH_OLDER_DONE, payload);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }

  // -----------------------------------------------------------------------
  // Retry scheduling
  // -----------------------------------------------------------------------

  private scheduleRetry(item: QueueItem): void {
    item.retryCount++;
    const delay = backoffDelay(item.retryCount - 1);
    item.status = 'pending';
    item.error = undefined;
    this.emitUpdate(item);

    log.info(`[MailQueue] Scheduling retry #${item.retryCount} for ${item.queueId} in ${delay}ms`);

    const timer = setTimeout(() => {
      this.retryTimers.delete(item.queueId);

      // Re-enqueue at the tail of the account's queue
      const q = this.getOrCreateQueue(item.accountId);
      q.push(item).catch(() => {});
    }, delay);

    this.retryTimers.set(item.queueId, timer);
  }

  /** Resume a paused account (e.g. after successful token refresh). */
  resumeAccount(accountId: number): void {
    this.pausedAccounts.delete(accountId);
    log.info(`[MailQueue] Resumed account ${accountId}`);
  }

  /** Check if an account's queue is paused. */
  isAccountPaused(accountId: number): boolean {
    return this.pausedAccounts.has(accountId);
  }

  // -----------------------------------------------------------------------
  // Event emission
  // -----------------------------------------------------------------------

  private emitUpdate(item: QueueItem): void {
    const snapshot = this.snapshot(item);
    try {
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (!win.isDestroyed()) {
          win.webContents.send(IPC_EVENTS.QUEUE_UPDATE, snapshot);
        }
      }
    } catch {
      // Window may not exist yet during startup
    }
  }

  private snapshot(item: QueueItem): QueueItemSnapshot {
    // Exclude payload from the snapshot (may contain large base64 data)
    const { payload: _payload, ...rest } = item;
    return rest;
  }

  // -----------------------------------------------------------------------
  // Add Labels worker
  // -----------------------------------------------------------------------

  private async processAddLabels(item: QueueItem): Promise<void> {
    const payload = item.payload as AddLabelsPayload;
    const imapService = ImapService.getInstance();
    const db = DatabaseService.getInstance();
    const win = BrowserWindow.getAllWindows()[0];

    let copiedCount = 0;

    let anyFailed = false;

    for (const labelFolder of payload.targetLabels) {
      let labelCopyCount = 0;
      for (const resolved of payload.resolvedEmails) {
        try {
          await imapService.copyMessages(
            String(item.accountId),
            resolved.sourceFolder,
            [resolved.uid],
            labelFolder
          );
          copiedCount++;
          labelCopyCount++;

          // Only update DB after IMAP COPY succeeds
          db.addEmailFolderAssociation(item.accountId, resolved.xGmMsgId, labelFolder);
        } catch (copyErr) {
          anyFailed = true;
          log.warn(`[MailQueue] add-labels: failed to copy ${resolved.xGmMsgId} to ${labelFolder}: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`);
        }
      }

      // Update thread_folders for this label only if at least one COPY succeeded
      if (payload.threadId && labelCopyCount > 0) {
        db.upsertThreadFolder(item.accountId, payload.threadId, labelFolder);
      }
    }

    // If every single operation failed, throw so queue item is marked failed/retried
    if (anyFailed && copiedCount === 0 && payload.resolvedEmails.length > 0) {
      throw new Error(`add-labels: all IMAP COPY operations failed for ${payload.targetLabels.join(', ')}`);
    }

    // Emit folder-updated so the renderer refreshes the thread list
    if (win) {
      const affectedFolders = [...payload.targetLabels];
      win.webContents.send(IPC_EVENTS.MAIL_FOLDER_UPDATED, {
        accountId: item.accountId,
        folders: affectedFolders,
        reason: 'add-labels',
      });
    }

    log.info(`[MailQueue] add-labels (${item.queueId}): copied to ${payload.targetLabels.length} label(s), ${copiedCount} message copies`);
  }

  // -----------------------------------------------------------------------
  // Remove Labels worker
  // -----------------------------------------------------------------------

  private async processRemoveLabels(item: QueueItem): Promise<void> {
    const payload = item.payload as RemoveLabelsPayload;
    const imapService = ImapService.getInstance();
    const db = DatabaseService.getInstance();
    const win = BrowserWindow.getAllWindows()[0];

    let removedCount = 0;
    let anyFailed = false;

    for (const labelFolder of payload.targetLabels) {
      // Use pre-resolved UIDs if available; fall back to IMAP resolution for labels added
      // without UIDs (e.g. added before sync populated the uid column).
      let uidsForLabel = payload.resolvedEmails
        .filter((resolved) => resolved.labelFolder === labelFolder)
        .map((resolved) => resolved.uid);

      if (uidsForLabel.length === 0) {
        // Fall back: resolve UIDs dynamically by searching the label folder
        log.info(`[MailQueue] remove-labels: no pre-resolved UIDs for ${labelFolder}, resolving dynamically`);
        try {
          const xGmMsgIdsForLabel = payload.xGmMsgIds;
          const resolved = await imapService.resolveUidsByXGmMsgId(
            String(item.accountId),
            labelFolder,
            xGmMsgIdsForLabel
          );
          uidsForLabel = Array.from(resolved.values());
        } catch (resolveErr) {
          log.warn(`[MailQueue] remove-labels: dynamic UID resolution failed for ${labelFolder}: ${resolveErr instanceof Error ? resolveErr.message : String(resolveErr)}`);
          anyFailed = true;
          continue;
        }
      }

      if (uidsForLabel.length === 0) {
        log.warn(`[MailQueue] remove-labels: no UIDs found for label folder ${labelFolder} — messages may already be removed`);
        // Clean up DB associations even if no UIDs found on server
        for (const xGmMsgId of payload.xGmMsgIds) {
          db.removeEmailFolderAssociation(item.accountId, xGmMsgId, labelFolder);
        }
        continue;
      }

      try {
        await imapService.removeFromLabel(
          String(item.accountId),
          labelFolder,
          uidsForLabel
        );
        removedCount += uidsForLabel.length;

        // Update DB only after IMAP success
        for (const xGmMsgId of payload.xGmMsgIds) {
          db.removeEmailFolderAssociation(item.accountId, xGmMsgId, labelFolder);
        }

        // Update thread_folders — remove if no messages remain in this label
        if (payload.threadId) {
          const remainingEmails = db.getEmailsByThreadId(item.accountId, payload.threadId);
          const stillInLabel = remainingEmails.some((email) => {
            const emailFolders = db.getFoldersForEmail(item.accountId, String(email['xGmMsgId'] ?? ''));
            return emailFolders.includes(labelFolder);
          });
          if (!stillInLabel) {
            db.removeThreadFolderAssociation(item.accountId, payload.threadId, labelFolder);
          }
        }
      } catch (removeErr) {
        anyFailed = true;
        log.warn(`[MailQueue] remove-labels: failed to remove from ${labelFolder}: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`);
      }
    }

    // If every operation failed, throw so queue item is marked failed/retried
    if (anyFailed && removedCount === 0 && payload.targetLabels.length > 0) {
      throw new Error(`remove-labels: all IMAP operations failed for ${payload.targetLabels.join(', ')}`);
    }

    // Emit folder-updated so the renderer refreshes
    if (win) {
      const affectedFolders = [...payload.targetLabels];
      win.webContents.send(IPC_EVENTS.MAIL_FOLDER_UPDATED, {
        accountId: item.accountId,
        folders: affectedFolders,
        reason: 'remove-labels',
      });
    }

    log.info(`[MailQueue] remove-labels (${item.queueId}): removed from ${payload.targetLabels.length} label(s), ${removedCount} message(s)`);
  }

  // -----------------------------------------------------------------------
  // Cleanup
  // -----------------------------------------------------------------------

  /** Cancel all pending retry timers (used on shutdown). */
  cancelAllRetries(): void {
    for (const [id, timer] of this.retryTimers.entries()) {
      clearTimeout(timer);
      this.retryTimers.delete(id);
    }
  }
}
