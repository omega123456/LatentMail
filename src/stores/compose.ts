import { create } from 'zustand';
import { addressKey } from '@/lib/format/participants';

export type ComposeMode = 'new' | 'reply' | 'reply-all' | 'forward' | 'draft';
export type RecipientRole = 'to' | 'cc' | 'bcc';
export type RecipientRoles = { to: string[]; cc: string[]; bcc: string[] };
export type ComposeDimensions = { width: number; height: number };
export type ComposeQuote = { html: string; attribution: string };

export type AttachmentState = 'reading' | 'settled' | 'failed';
export type DraftStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'superseded';

export type ComposeAttachment = {
  localId: string;
  filename: string;
  mimeType: string;
  size: number;
  state: AttachmentState;
  staged: { id: string; path: string; assetUrl: string; size: number } | null;
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
type OpenArgs = OpenComposeArgs;

type ComposeStore = {
  session: ComposeSession | null;
  open: (session: OpenArgs) => void;
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
  addReadingAttachment: (attachment: {
    localId: string;
    filename: string;
    mimeType: string;
    contentId: string | null;
  }) => void;
  settleAttachment: (
    localId: string,
    staged: { id: string; path: string; assetUrl: string; size: number },
  ) => void;
  failAttachment: (localId: string, error: string) => void;
  removeAttachment: (localId: string) => void;
  setDraftStatus: (status: DraftStatus, error?: string | null) => void;
  setDraftId: (draftId: string) => void;
  markSaved: () => void;
};

export const COMPOSE_MIN_PX = 360;

const COMPOSE_FLOOR = { width: 512, height: 500 };
const COMPOSE_CEILING = { width: 840, height: 820 };
const COMPOSE_VIEWPORT_FRACTION = { width: 0.42, height: 0.62 };
const COMPOSE_VIEWPORT_INSET = 48;

function axis(viewport: number, floor: number, ceiling: number, fraction: number) {
  const preferred = Math.max(floor, Math.round(viewport * fraction));
  const available = Math.max(COMPOSE_MIN_PX, Math.min(ceiling, viewport - COMPOSE_VIEWPORT_INSET));
  return Math.min(preferred, available);
}

function initialDimensions(): ComposeDimensions {
  return {
    width: axis(
      window.innerWidth,
      COMPOSE_FLOOR.width,
      COMPOSE_CEILING.width,
      COMPOSE_VIEWPORT_FRACTION.width,
    ),
    height: axis(
      window.innerHeight,
      COMPOSE_FLOOR.height,
      COMPOSE_CEILING.height,
      COMPOSE_VIEWPORT_FRACTION.height,
    ),
  };
}
const defaultOverflow: Record<RecipientRole, number> = { to: 0, cc: 0, bcc: 0 };

function normalizeRecipient(raw: string): string | null {
  const trimmed = raw.trim().replace(/,+$/, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

export const useComposeStore = create<ComposeStore>((set) => ({
  session: null,
  open: (session) =>
    set({
      session: {
        ...session,
        dirty: false,
        ccBccRevealed: session.recipients.cc.length > 0 || session.recipients.bcc.length > 0,
        overflow: { ...defaultOverflow },
        quote: session.quote ?? null,
        quoteOpen: false,
        dimensions: session.dimensions ?? initialDimensions(),
        attachments: session.attachments ?? [],
        draftId: session.draftId ?? null,
        threadId: session.threadId ?? null,
        inReplyTo: session.inReplyTo ?? null,
        references: session.references ?? [],
        originalMessageId: session.originalMessageId ?? null,
        originalGmailMessageId: session.originalGmailMessageId ?? null,
        draftStatus: 'idle',
        lifecycleError: null,
      },
    }),
  close: () => set({ session: null }),
  setSubject: (subject) =>
    set((state) =>
      state.session ? { session: { ...state.session, subject, dirty: true } } : state,
    ),
  setHtml: (html) =>
    set((state) => (state.session ? { session: { ...state.session, html, dirty: true } } : state)),
  setDimensions: (dimensions) =>
    set((state) => (state.session ? { session: { ...state.session, dimensions } } : state)),
  commitRecipient: (role, raw) =>
    set((state) => {
      if (!state.session) return state;
      const value = normalizeRecipient(raw);
      if (!value) return state;
      const existing = state.session.recipients[role];
      const key = addressKey(value);
      if (existing.some((entry) => addressKey(entry) === key)) return state;
      return {
        session: {
          ...state.session,
          recipients: { ...state.session.recipients, [role]: [...existing, value] },
          dirty: true,
        },
      };
    }),
  removeRecipient: (role, index) =>
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          recipients: {
            ...state.session.recipients,
            [role]: state.session.recipients[role].filter((_, entryIndex) => entryIndex !== index),
          },
          dirty: true,
        },
      };
    }),
  removeLastRecipient: (role) =>
    set((state) => {
      if (!state.session || state.session.recipients[role].length === 0) return state;
      return {
        session: {
          ...state.session,
          recipients: {
            ...state.session.recipients,
            [role]: state.session.recipients[role].slice(0, -1),
          },
          dirty: true,
        },
      };
    }),
  revealCcBcc: () =>
    set((state) =>
      state.session ? { session: { ...state.session, ccBccRevealed: true } } : state,
    ),
  setOverflowCount: (role, count) =>
    set((state) =>
      state.session
        ? { session: { ...state.session, overflow: { ...state.session.overflow, [role]: count } } }
        : state,
    ),
  toggleQuote: () =>
    set((state) =>
      state.session
        ? { session: { ...state.session, quoteOpen: !state.session.quoteOpen } }
        : state,
    ),
  addReadingAttachment: ({ localId, filename, mimeType, contentId }) =>
    set((state) => {
      if (!state.session) return state;
      const attachment: ComposeAttachment = {
        localId,
        filename,
        mimeType,
        size: 0,
        state: 'reading',
        staged: null,
        contentId,
        error: null,
      };
      return {
        session: {
          ...state.session,
          attachments: [...state.session.attachments, attachment],
          dirty: true,
        },
      };
    }),
  settleAttachment: (localId, staged) =>
    set((state) => {
      if (!state.session) return state;
      if (!state.session.attachments.some((entry) => entry.localId === localId)) return state;
      return {
        session: {
          ...state.session,
          attachments: state.session.attachments.map((entry) =>
            entry.localId === localId
              ? { ...entry, state: 'settled', staged, size: staged.size, error: null }
              : entry,
          ),
        },
      };
    }),
  failAttachment: (localId, error) =>
    set((state) => {
      if (!state.session) return state;
      if (!state.session.attachments.some((entry) => entry.localId === localId)) return state;
      return {
        session: {
          ...state.session,
          attachments: state.session.attachments.map((entry) =>
            entry.localId === localId ? { ...entry, state: 'failed', error } : entry,
          ),
        },
      };
    }),
  removeAttachment: (localId) =>
    set((state) => {
      if (!state.session) return state;
      return {
        session: {
          ...state.session,
          attachments: state.session.attachments.filter((entry) => entry.localId !== localId),
          dirty: true,
        },
      };
    }),
  setDraftStatus: (draftStatus, lifecycleError = null) =>
    set((state) =>
      state.session ? { session: { ...state.session, draftStatus, lifecycleError } } : state,
    ),
  setDraftId: (draftId) =>
    set((state) => (state.session ? { session: { ...state.session, draftId } } : state)),
  markSaved: () =>
    set((state) =>
      state.session
        ? {
            session: { ...state.session, dirty: false, draftStatus: 'saved', lifecycleError: null },
          }
        : state,
    ),
}));

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
