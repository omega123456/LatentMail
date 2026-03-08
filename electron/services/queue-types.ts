/**
 * Shared type definitions for mail queue operations.
 *
 * This module is the canonical location for all queue-related types.
 * Both MailQueueService and BodyFetchQueueService import from here.
 * mail-queue-service.ts re-exports everything for backward compatibility.
 */

// ---------------------------------------------------------------------------
// Queue operation types
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

// ---------------------------------------------------------------------------
// Payload interfaces
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Queue item types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Push-event payload types
// ---------------------------------------------------------------------------

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
