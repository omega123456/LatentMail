export interface Email {
  id: number;
  accountId: number;
  xGmMsgId: string;
  xGmThrid: string;
  /** RFC 5322 Message-ID, used for In-Reply-To/References. */
  messageId?: string;
  folder: string;
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
  isDraft: boolean;
  snippet?: string;
  size?: number;
  hasAttachments: boolean;
  labels?: string;
  /** Folders this message appears in (from email_folders). Set when loading a thread so UI can show e.g. Draft badge. */
  folders?: string[];
  /** Attachment metadata for this message (populated when loading a thread). */
  attachments?: Attachment[];
}

export interface Thread {
  id: number;
  accountId: number;
  xGmThrid: string;
  subject?: string;
  lastMessageDate: string;
  participants?: string;
  /** When viewing Sent folder: to_addresses of the latest message in that folder (for "To: …" display). */
  toParticipants?: string;
  messageCount: number;
  snippet?: string;
  folder?: string;
  isRead: boolean;
  isStarred: boolean;
  folders?: string[];
  hasDraft?: boolean;
  /** Whether any message in the thread has attachments. Derived from thread query. */
  hasAttachments?: boolean;
  messages?: Email[];
  labels?: Array<{ id: number; name: string; color?: string | null; gmailLabelId: string }>;
}

export interface Attachment {
  id: number;
  emailId: number;
  filename: string;
  mimeType?: string;
  size?: number;
  contentId?: string;
  localPath?: string;
}

export interface Contact {
  id: number;
  email: string;
  displayName?: string;
  frequency: number;
  lastContactedAt?: string;
}

export type ComposeMode = 'new' | 'reply' | 'reply-all' | 'forward';

export interface Draft {
  id?: number;
  accountId: number;
  xGmThrid?: string;
  subject: string;
  to: string;
  cc: string;
  bcc: string;
  htmlBody: string;
  textBody: string;
  inReplyTo?: string;
  references?: string;
  attachments: DraftAttachment[];
  signature?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DraftAttachment {
  id?: string;
  filename: string;
  mimeType: string;
  size: number;
  data?: string; // base64
  path?: string;
}

export interface ComposeContext {
  mode: ComposeMode;
  accountId: number;
  accountEmail: string;
  accountDisplayName: string;
  draft?: Draft;
  originalThread?: Thread;
  originalMessage?: Email;
  /** xGmMsgId of a server draft opened from [Gmail]/Drafts for edit (backend resolves UID) */
  serverDraftXGmMsgId?: string;
  /** Pre-fill the compose body with this text (e.g. AI smart reply suggestion) */
  prefillBody?: string;
  /** Pre-fill the TO field when opening a new compose (e.g. from thread view address click) */
  to?: string;
  /** Pre-fill CC field (e.g. from mailto: URL) */
  cc?: string;
  /** Pre-fill BCC field (e.g. from mailto: URL) */
  bcc?: string;
  /** Pre-fill Subject field (e.g. from mailto: URL) */
  subject?: string;
}
