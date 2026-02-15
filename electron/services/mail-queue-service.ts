import { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import * as fastq from 'fastq';
import { randomUUID } from 'crypto';
import { ImapService } from './imap-service';
import { DatabaseService } from './database-service';
import { FolderLockManager } from './folder-lock-manager';
import { buildDraftMime } from './draft-mime';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type QueueOperationType =
  | 'draft-create'
  | 'draft-update'
  | 'send'
  | 'move'
  | 'flag'
  | 'delete';

export type QueueItemStatus = 'pending' | 'processing' | 'completed' | 'failed';

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
  originalQueueId: string;
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
  /** queueId of the draft being sent (optional; for draft cleanup). */
  originalQueueId?: string;
}

export interface MovePayload {
  messageIds: string[];
  sourceFolder?: string;
  targetFolder: string;
}

export interface FlagPayload {
  messageIds: string[];
  flag: string;
  value: boolean;
}

export interface DeletePayload {
  messageIds: string[];
  folder: string;
}

export type QueuePayload =
  | DraftPayload
  | DraftUpdatePayload
  | SendPayload
  | MovePayload
  | FlagPayload
  | DeletePayload;

export interface ServerIds {
  gmailMessageId: string;
  gmailThreadId: string;
  imapUid: number;
  imapUidValidity: number;
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
}

/** Serialisable snapshot of a QueueItem sent to the renderer. */
export type QueueItemSnapshot = Omit<QueueItem, 'payload'>;

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
   */
  enqueue(
    accountId: number,
    type: QueueOperationType,
    payload: QueuePayload,
    description: string,
    providedQueueId?: string,
  ): string {
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
    };

    this.items.set(queueId, item);
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

  /** Clear completed items from the tracking map. */
  clearCompleted(): number {
    let count = 0;
    for (const [id, item] of this.items.entries()) {
      if (item.status === 'completed') {
        this.items.delete(id);
        count++;
      }
    }
    return count;
  }

  /** Cancel a pending (not yet processing) operation. */
  cancel(queueId: string): boolean {
    const item = this.items.get(queueId);
    if (!item || item.status !== 'pending') return false;

    item.status = 'failed';
    item.error = 'Cancelled by user';
    item.completedAt = new Date().toISOString();
    this.emitUpdate(item);

    // Clear any pending retry timer
    const timer = this.retryTimers.get(queueId);
    if (timer) {
      clearTimeout(timer);
      this.retryTimers.delete(queueId);
    }

    return true;
  }

  /** Count of non-completed/non-failed items. */
  getPendingCount(): number {
    let count = 0;
    for (const item of this.items.values()) {
      if (item.status === 'pending' || item.status === 'processing') count++;
    }
    return count;
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
        // Phase 2/3 placeholders — will be implemented later
        case 'send':
        case 'move':
        case 'flag':
        case 'delete':
          throw new Error(`Operation type "${item.type}" not yet implemented in queue`);
        default:
          throw new Error(`Unknown operation type: ${item.type}`);
      }

      // Success
      item.status = 'completed';
      item.completedAt = new Date().toISOString();
      this.emitUpdate(item);
      log.info(`[MailQueue] Completed ${item.type} (${item.queueId})`);
    } catch (err) {
      const category = classifyError(err);
      const errMsg = err instanceof Error ? err.message : String(err);

      log.warn(`[MailQueue] Failed ${item.type} (${item.queueId}): [${category}] ${errMsg}`);

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
          attachments.push({
            filename: att.filename,
            content: Buffer.from(att.data, 'base64'),
            contentType: att.mimeType,
          });
        }
      }
    }

    // Build MIME
    const mimeBuffer = await buildDraftMime({
      from: `${account.display_name} <${account.email}>`,
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
    const release = await lockManager.acquire(GMAIL_DRAFTS_FOLDER);
    try {
      // APPEND to Gmail Drafts
      const appendResult = await imapService.appendDraft(String(item.accountId), mimeBuffer);
      const imapUid = appendResult.uid;
      const imapUidValidity = appendResult.uidValidity;

      if (imapUid == null) {
        log.warn(`[MailQueue] draft-create (${item.queueId}): APPEND did not return UID — draft saved but not tracked locally`);
        // Still consider this a success — draft exists on server, will appear on next sync
        item.result = null;
        return;
      }

      // Fetch the newly appended message back from the server to get server-confirmed data
      const fetched = await imapService.fetchMessageByUid(String(item.accountId), GMAIL_DRAFTS_FOLDER, imapUid);

      // Determine server IDs
      const gmailMessageId = fetched?.gmailMessageId || draftMessageId;
      const gmailThreadId = fetched?.gmailThreadId || draftMessageId;

      // Insert server-confirmed data into local DB
      db.upsertEmail({
        accountId: item.accountId,
        gmailMessageId,
        gmailThreadId,
        folder: GMAIL_DRAFTS_FOLDER,
        folderUid: imapUid,
        fromAddress: account.email,
        fromName: account.display_name,
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
        snippet: (payload.textBody || '').substring(0, 100),
        hasAttachments: (payload.attachments?.length ?? 0) > 0,
      });

      // Upsert thread
      const existingThread = db.getThreadById(item.accountId, gmailThreadId);
      let dbThreadId: number;
      if (existingThread) {
        dbThreadId = existingThread['id'] as number;
      } else {
        dbThreadId = db.upsertThread({
          accountId: item.accountId,
          gmailThreadId,
          subject: payload.subject || '',
          lastMessageDate: new Date().toISOString(),
          participants: account.email,
          messageCount: 1,
          snippet: (payload.textBody || '').substring(0, 100),
          folder: GMAIL_DRAFTS_FOLDER,
          isRead: true,
          isStarred: false,
        });
      }
      db.upsertThreadFolder(dbThreadId, item.accountId, GMAIL_DRAFTS_FOLDER);

      // Store server ID mapping
      const serverIds: ServerIds = { gmailMessageId, gmailThreadId, imapUid, imapUidValidity };
      this.queueIdToServerIds.set(item.queueId, serverIds);
      item.result = serverIds;

      log.info(`[MailQueue] draft-create (${item.queueId}): uid=${imapUid}, msgId=${gmailMessageId}`);
    } finally {
      release();
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

    // Resolve the server IDs from the original draft-create
    const oldServerIds = this.queueIdToServerIds.get(payload.originalQueueId);
    if (!oldServerIds) {
      // Fallback: treat as draft-create (mapping lost, e.g. after app restart)
      log.warn(`[MailQueue] draft-update (${item.queueId}): no server IDs for originalQueueId=${payload.originalQueueId}, falling back to draft-create`);
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
          attachments.push({
            filename: att.filename,
            content: Buffer.from(att.data, 'base64'),
            contentType: att.mimeType,
          });
        }
      }
    }

    // Build MIME
    const mimeBuffer = await buildDraftMime({
      from: `${account.display_name} <${account.email}>`,
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

    const release = await lockManager.acquire(GMAIL_DRAFTS_FOLDER);
    try {
      // APPEND new version first (safe — no data loss if this fails)
      const appendResult = await imapService.appendDraft(String(item.accountId), mimeBuffer);
      const newUid = appendResult.uid;
      const newUidValidity = appendResult.uidValidity;

      // Delete old draft from server (best-effort after successful append)
      try {
        await imapService.deleteDraftByUid(
          String(item.accountId),
          GMAIL_DRAFTS_FOLDER,
          oldServerIds.imapUid,
          oldServerIds.imapUidValidity,
        );

        // Clean up old email/thread associations from local DB
        db.removeEmailFolderAssociation(item.accountId, oldServerIds.gmailMessageId, GMAIL_DRAFTS_FOLDER);
        const oldEmail = db.getEmailByGmailMessageId(item.accountId, oldServerIds.gmailMessageId);
        if (oldEmail) {
          const oldThreadId = String(oldEmail['gmailThreadId'] || '');
          if (oldThreadId && !db.threadHasEmailsInFolder(item.accountId, oldThreadId, GMAIL_DRAFTS_FOLDER)) {
            const oldInternalThreadId = db.getThreadInternalId(item.accountId, oldThreadId);
            if (oldInternalThreadId != null) {
              db.removeThreadFolderAssociation(oldInternalThreadId, GMAIL_DRAFTS_FOLDER);
            }
          }
        }
      } catch (delErr) {
        log.warn(`[MailQueue] draft-update (${item.queueId}): failed to delete old draft uid=${oldServerIds.imapUid} (continuing):`, delErr);
      }

      if (newUid == null) {
        log.warn(`[MailQueue] draft-update (${item.queueId}): APPEND did not return UID`);
        // Remove old mapping, set result null
        this.queueIdToServerIds.delete(payload.originalQueueId);
        item.result = null;
        return;
      }

      // Fetch the new message from server
      const fetched = await imapService.fetchMessageByUid(String(item.accountId), GMAIL_DRAFTS_FOLDER, newUid);
      const gmailMessageId = fetched?.gmailMessageId || newMessageId;
      // Preserve the original thread ID to avoid creating a new thread (dedupe)
      const gmailThreadId = fetched?.gmailThreadId || oldServerIds.gmailThreadId;

      // Insert new server-confirmed data into local DB
      db.upsertEmail({
        accountId: item.accountId,
        gmailMessageId,
        gmailThreadId,
        folder: GMAIL_DRAFTS_FOLDER,
        folderUid: newUid,
        fromAddress: account.email,
        fromName: account.display_name,
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
        snippet: (payload.textBody || '').substring(0, 100),
        hasAttachments: (payload.attachments?.length ?? 0) > 0,
      });

      // Upsert thread
      const existingThread = db.getThreadById(item.accountId, gmailThreadId);
      let dbThreadId: number;
      if (existingThread) {
        dbThreadId = existingThread['id'] as number;
      } else {
        dbThreadId = db.upsertThread({
          accountId: item.accountId,
          gmailThreadId,
          subject: payload.subject || '',
          lastMessageDate: new Date().toISOString(),
          participants: account.email,
          messageCount: 1,
          snippet: (payload.textBody || '').substring(0, 100),
          folder: GMAIL_DRAFTS_FOLDER,
          isRead: true,
          isStarred: false,
        });
      }
      db.upsertThreadFolder(dbThreadId, item.accountId, GMAIL_DRAFTS_FOLDER);

      // Update server ID mapping (point the ORIGINAL queueId to the new server IDs)
      const serverIds: ServerIds = { gmailMessageId, gmailThreadId, imapUid: newUid, imapUidValidity: newUidValidity };
      this.queueIdToServerIds.set(payload.originalQueueId, serverIds);
      item.result = serverIds;

      log.info(`[MailQueue] draft-update (${item.queueId}): new uid=${newUid}, old uid=${oldServerIds.imapUid} deleted`);
    } finally {
      release();
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
          win.webContents.send('queue:update', snapshot);
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
