import { create } from 'zustand';
import type { ComposeMode } from '@/lib/types/ipc';
import {
  addReadingAttachmentToSession,
  commitRecipientToSession,
  COMPOSE_MIN_PX,
  createComposeSession,
  failAttachmentInSession,
  recordSessionDraftSaved,
  removeAttachmentFromSession,
  removeLastRecipientFromSession,
  removeRecipientFromSession,
  setSessionDraftStatus,
  settleAttachmentInSession,
} from './compose/transitions';

export { COMPOSE_MIN_PX };
export type { ComposeMode };
export type RecipientRole = 'to' | 'cc' | 'bcc';
export type RecipientRoles = { to: string[]; cc: string[]; bcc: string[] };
export type ComposeDimensions = { width: number; height: number };
export type ComposeQuote = { html: string; attribution: string };

export type AttachmentState = 'reading' | 'settled' | 'failed';
export type DraftStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'superseded';

export type StagedAttachmentInfo = {
  id: string;
  path: string;
  assetUrl: string;
  size: number;
};

export type ReadingAttachmentInput = {
  localId: string;
  filename: string;
  mimeType: string;
  contentId: string | null;
};

export type ComposeAttachment = {
  localId: string;
  filename: string;
  mimeType: string;
  size: number;
  state: AttachmentState;
  staged: StagedAttachmentInfo | null;
  contentId: string | null;
  error: string | null;
};

export type ComposeSession = {
  id: string;
  mode: ComposeMode;
  accountId: string;
  from: string;
  recipients: RecipientRoles;
  ccBccRevealed: boolean;
  overflow: Record<RecipientRole, number>;
  subject: string;
  html: string;
  quote: ComposeQuote | null;
  quoteOpen: boolean;
  dirty: boolean;
  dimensions: ComposeDimensions;
  attachments: ComposeAttachment[];
  draftId: string | null;
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
  originalMessageId: string | null;
  originalGmailMessageId: string | null;
  draftStatus: DraftStatus;
  lifecycleError: string | null;
};

export type OpenComposeArgs = Omit<
  ComposeSession,
  | 'dirty'
  | 'dimensions'
  | 'ccBccRevealed'
  | 'overflow'
  | 'quoteOpen'
  | 'quote'
  | 'attachments'
  | 'draftId'
  | 'threadId'
  | 'inReplyTo'
  | 'references'
  | 'originalMessageId'
  | 'originalGmailMessageId'
  | 'draftStatus'
  | 'lifecycleError'
> &
  Partial<
    Pick<
      ComposeSession,
      | 'dimensions'
      | 'quote'
      | 'attachments'
      | 'draftId'
      | 'threadId'
      | 'inReplyTo'
      | 'references'
      | 'originalMessageId'
      | 'originalGmailMessageId'
    >
  >;

type ComposeStore = {
  session: ComposeSession | null;
  open: (session: OpenComposeArgs) => void;
  close: () => void;
  setSubject: (subject: string) => void;
  setHtml: (html: string) => void;
  setDimensions: (dimensions: ComposeDimensions) => void;
  commitRecipient: (role: RecipientRole, raw: string) => void;
  removeRecipient: (role: RecipientRole, index: number) => void;
  removeLastRecipient: (role: RecipientRole) => void;
  revealCcBcc: () => void;
  setOverflowCount: (role: RecipientRole, count: number) => void;
  toggleQuote: () => void;
  addReadingAttachment: (attachment: ReadingAttachmentInput) => void;
  settleAttachment: (localId: string, staged: StagedAttachmentInfo) => void;
  failAttachment: (localId: string, error: string) => void;
  removeAttachment: (localId: string) => void;
  setDraftStatus: (status: DraftStatus, error?: string | null) => void;
  recordDraftSaved: (sessionId: string, draftId: string | null) => void;
  recordDraftFailed: (sessionId: string, error: string) => void;
};

function applySessionUpdate(
  state: ComposeStore,
  transform: (session: ComposeSession) => ComposeSession,
): Partial<ComposeStore> | ComposeStore {
  if (!state.session) return state;
  const next = transform(state.session);
  if (next === state.session) return state;
  return { session: next };
}

export const useComposeStore = create<ComposeStore>((set) => {
  const updateSession = (transform: (session: ComposeSession) => ComposeSession) =>
    set((state) => applySessionUpdate(state, transform));
  const updateSessionWithId = (
    sessionId: string,
    transform: (session: ComposeSession) => ComposeSession,
  ) => updateSession((session) => (session.id === sessionId ? transform(session) : session));

  return {
    session: null,
    open: (session) => set({ session: createComposeSession(session) }),
    close: () => set({ session: null }),
    setSubject: (subject) =>
      updateSession((session) => ({ ...session, subject: subject, dirty: true })),
    setHtml: (html) => updateSession((session) => ({ ...session, html: html, dirty: true })),
    setDimensions: (dimensions) => updateSession((session) => ({ ...session, dimensions })),
    commitRecipient: (role, raw) =>
      updateSession((session) => commitRecipientToSession(session, { role, raw })),
    removeRecipient: (role, index) =>
      updateSession((session) => removeRecipientFromSession(session, { role, index })),
    removeLastRecipient: (role) =>
      updateSession((session) => removeLastRecipientFromSession(session, role)),
    revealCcBcc: () => updateSession((session) => ({ ...session, ccBccRevealed: true })),
    setOverflowCount: (role, count) =>
      updateSession((session) => ({
        ...session,
        overflow: { ...session.overflow, [role]: count },
      })),
    toggleQuote: () => updateSession((session) => ({ ...session, quoteOpen: !session.quoteOpen })),
    addReadingAttachment: (attachment) =>
      updateSession((session) => addReadingAttachmentToSession(session, attachment)),
    settleAttachment: (localId, staged) =>
      updateSession((session) => settleAttachmentInSession(session, { localId, staged })),
    failAttachment: (localId, error) =>
      updateSession((session) => failAttachmentInSession(session, { localId, error })),
    removeAttachment: (localId) =>
      updateSession((session) => removeAttachmentFromSession(session, localId)),
    setDraftStatus: (draftStatus, lifecycleError = null) =>
      updateSession((session) => setSessionDraftStatus(session, { draftStatus, lifecycleError })),
    recordDraftSaved: (sessionId, draftId) =>
      updateSessionWithId(sessionId, (session) => recordSessionDraftSaved(session, draftId)),
    recordDraftFailed: (sessionId, error) =>
      updateSessionWithId(sessionId, (session) =>
        setSessionDraftStatus(session, { draftStatus: 'failed', lifecycleError: error }),
      ),
  };
});

export const selectHasCommittedRecipient = (state: ComposeStore) =>
  (state.session?.recipients.to.length ?? 0) > 0;

export const selectHasReadingAttachment = (state: ComposeStore) =>
  (state.session?.attachments ?? []).some((attachment) => attachment.state === 'reading');

export const selectQualifiesForDraft = (state: ComposeStore) => {
  const session = state.session;
  return Boolean(
    session && (session.recipients.to.length || session.subject.trim() || session.html.trim()),
  );
};

export const modeTitles: Record<ComposeMode, string> = {
  new: 'New Message',
  reply: 'Reply',
  'reply-all': 'Reply All',
  forward: 'Forward',
  draft: 'Draft',
};
