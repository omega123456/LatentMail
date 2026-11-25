export type ConversationEntryScope =
  { kind: 'mailbox'; mailboxId: string } | { kind: 'search'; scope: SearchScope };

export interface MailLabelColor {
  text: string;
  background: string;
}

export interface MailLabel {
  id: string;
  name: string;
  kind: string;
  color: MailLabelColor | null;
  messageCount: number;
  unreadCount: number;
}

export type MoveDestination = 'INBOX' | 'SPAM' | 'TRASH';

export type MutationOutcome = 'applied' | 'superseded';

export interface MutationResult {
  threadId: string;
  outcome: MutationOutcome;
}

export interface ThreadIdentity {
  display: string;
  address: string | null;
}

export interface MailThread {
  id: string;
  subject: string;
  sender: ThreadIdentity;
  sentRecipient: ThreadIdentity | null;
  latestAt: number;
  messageCount: number;
  isUnread: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  hasDraft: boolean;
  snippet?: string;
  labelIndicators?: string[];
  systemLabelIds?: string[];
}

export interface ThreadCursor {
  latestAt: number;
  id: string;
}

export type ThreadPageDirection = 'forward' | 'backward';

export interface ThreadPageParam {
  cursor: ThreadCursor;
  direction: ThreadPageDirection;
}

export interface ThreadPage {
  items: MailThread[];
  nextCursor: ThreadCursor | null;
  previousCursor?: ThreadCursor | null;
}

export interface ThreadSearchPage {
  items: MailThread[];
  nextCursor: ThreadCursor | null;
  previousCursor?: ThreadCursor | null;
  total?: number;
}

export type SearchScope =
  { kind: 'default' } | { kind: 'all' } | { kind: 'label'; labelId: string };

export type SearchPredicate =
  | { kind: 'label'; value: string; negated: boolean }
  | { kind: 'unread'; negated: boolean }
  | { kind: 'starred'; negated: boolean }
  | { kind: 'hasAttachment'; negated: boolean }
  | { kind: 'sentBefore'; atSeconds: number; negated: boolean }
  | { kind: 'sentAfter'; atSeconds: number; negated: boolean }
  | { kind: 'textExcludes'; negated: boolean };

export interface ParsedSearchQuery {
  hasTextTerm: boolean;
  from: string | null;
  to: string | null;
  subject: string | null;
  includes: string[];
  excludes: string[];
  predicates: SearchPredicate[];
}

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  position: number;
}

export interface ConversationMessage {
  id: string;
  sender: string;
  recipients: string[];
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  subject: string;
  sentAt: number;
  snippet: string;
  htmlBody: string | null;
  htmlPresence: 'neverFetched' | 'present' | 'absent' | 'tooLarge';
  plainBody: string | null;
  hasAttachments: boolean;
  isUnread: boolean;
  isStarred: boolean;
  labelIds: string[];
  remoteImagesBlocked: boolean;
  remoteImagesAllowed: boolean;
  inlineImagesPending: boolean;
  draftId?: string | null;
  truncated: boolean;
  attachments: MessageAttachment[];
}

export interface ImagePolicy {
  alwaysLoad: boolean;
  allowedSenders: string[];
  loadFor: string[];
}

export interface Conversation {
  threadId: string;
  subject: string;
  messages: ConversationMessage[];
}

export interface MessageBody {
  htmlBody: string | null;
  plainBody: string | null;
  htmlPresence: 'neverFetched' | 'present' | 'absent' | 'tooLarge';
  truncated: boolean;
  remoteImagesBlocked: boolean;
  remoteImagesAllowed: boolean;
  inlineImagesPending: boolean;
}

export interface MessageSource {
  messageId: string | null;
  sentAt: number;
  sender: string;
  to: string;
  cc: string;
  subject: string;
  authenticationResults: string | null;
  sizeBytes: number;
  raw: string;
  display: string;
}
