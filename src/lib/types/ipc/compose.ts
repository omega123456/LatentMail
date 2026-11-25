export interface ContactSuggestion {
  address: string;
  displayName: string | null;
}

export interface ReplyContextAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}

export interface ReplyContext {
  to: string[];
  cc: string[];
  subject: string;
  originalMessageId: string;
  targetThreadId: string | null;
  inReplyTo: string | null;
  references: string[];
  originalGmailMessageId: string;
  displayQuote: { html: string; attribution: string } | null;
  attachments: ReplyContextAttachment[];
}

export interface StagedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  path: string;
  contentId: string | null;
  size: number;
}

export type ComposeMode = 'new' | 'reply' | 'reply-all' | 'forward' | 'draft';

export interface ComposeDraftRequest {
  sessionId: string;
  accountId: string;
  draftId: string | null;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  mode: ComposeMode;
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
  originalMessageId: string | null;
  originalGmailMessageId: string | null;
  quoteHtml: string | null;
  quotePlain: string | null;
  editableBodyFingerprint?: string | null;
  attachments: { id: string; filename: string; mimeType: string; contentId: string | null }[];
}

export interface ComposeQueueAcceptance {
  operationId: string;
  draftId?: string | null;
}

export interface HydratedComposeDraft extends ComposeDraftRequest {
  draftId: string;
  attachments: StagedAttachment[];
  quoteHtml: string | null;
  quotePlain: string | null;
}

export interface CachedAttachmentDto {
  cachePath: string;
  displayPath: string;
  mimeType: string;
  filename: string;
  size: number;
}
