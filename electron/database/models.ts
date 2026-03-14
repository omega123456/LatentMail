/**
 * Type definitions for all database models used across the codebase.
 * New-era schema: X-GM-MSGID as primary identifier for emails, X-GM-THRID for threads.
 */

// ---- Email ----

interface EmailRecord {
  id: number;
  accountId: number;
  xGmMsgId: string;
  xGmThrid: string;
  /** RFC 5322 Message-ID (for compose In-Reply-To/References) */
  messageId: string | null;
  fromAddress: string;
  fromName: string;
  toAddresses: string;
  ccAddresses: string;
  bccAddresses: string;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  isDraft: boolean;
  isFiltered: boolean;
  snippet: string;
  size: number;
  hasAttachments: boolean;
  labels: string;
  createdAt: string;
}

// ---- Email-Folder Junction ----

interface EmailFolderRecord {
  id: number;
  accountId: number;
  xGmMsgId: string;
  folder: string;
  uid: number | null;
}

// ---- Thread ----

interface ThreadRecord {
  id: number;
  accountId: number;
  xGmThrid: string;
  subject: string;
  lastMessageDate: string;
  participants: string;
  messageCount: number;
  snippet: string;
  isRead: boolean;
  isStarred: boolean;
  createdAt: string;
  updatedAt: string;
}

// ---- Thread-Folder Junction ----

interface ThreadFolderRecord {
  id: number;
  accountId: number;
  xGmThrid: string;
  folder: string;
}

// ---- Folder State (CONDSTORE) ----

export interface FolderStateRecord {
  id: number;
  accountId: number;
  folder: string;
  /** Server UIDVALIDITY (stored as text, serialized from BigInt) */
  uidValidity: string;
  /** Server HIGHESTMODSEQ (stored as text, serialized from BigInt). NULL for initial state or NOMODSEQ folders. */
  highestModseq: string | null;
  /** 0 if folder reported NOMODSEQ, 1 otherwise */
  condstoreSupported: boolean;
  /** ISO 8601 timestamp of last full UID reconciliation */
  lastReconciledAt: string | null;
  updatedAt: string;
}

// ---- Upsert Input Types (used by DatabaseService methods) ----

export interface UpsertEmailInput {
  accountId: number;
  xGmMsgId: string;
  xGmThrid: string;
  messageId?: string;
  folder: string;
  folderUid?: number;
  fromAddress: string;
  fromName?: string;
  toAddresses: string;
  ccAddresses?: string;
  bccAddresses?: string;
  subject?: string;
  textBody?: string;
  htmlBody?: string;
  date: string;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  isDraft?: boolean;
  snippet?: string;
  size?: number;
  hasAttachments: boolean;
  labels?: string;
}

export interface UpsertThreadInput {
  accountId: number;
  xGmThrid: string;
  subject?: string;
  lastMessageDate: string;
  participants?: string;
  messageCount: number;
  snippet?: string;
  isRead: boolean;
  isStarred: boolean;
}

export interface UpsertFolderStateInput {
  accountId: number;
  folder: string;
  uidValidity: string;
  highestModseq?: string | null;
  condstoreSupported?: boolean;
  lastReconciledAt?: string | null;
}

// ---- Attachment ----

export interface AttachmentRecord {
  id: number;
  emailId: number;
  filename: string;
  mimeType: string | null;
  size: number | null;
  contentId: string | null;
  localPath: string | null;
  createdAt: string;
}

// ---- Payload for folder-updated event ----

interface FolderUpdatedPayload {
  accountId: number;
  folders: string[];
  reason: 'sync' | 'move' | 'delete' | 'flag' | 'send' | 'draft-create' | 'draft-update' | 'filter';
  changeType?: 'new_messages' | 'flag_changes' | 'deletions' | 'mixed';
  count?: number;
}
