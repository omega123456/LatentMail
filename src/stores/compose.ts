import { create } from 'zustand';
import { addressKey } from '@/lib/format/participants';

export type ComposeMode = 'new' | 'reply' | 'reply-all' | 'forward' | 'draft';
export type RecipientRole = 'to' | 'cc' | 'bcc';
export type RecipientRoles = { to: string[]; cc: string[]; bcc: string[] };
export type ComposeDimensions = { width: number; height: number };
/** The sanitized, script-free display quote handed to `QuoteDisclosure`.
 * Populated by the reply/forward derivation wired in a later phase — the
 * field exists now so the disclosure's own open/closed behavior is complete
 * and testable in this phase without inventing content-population logic. */
export type ComposeQuote = { html: string; attribution: string };

export type AttachmentState = 'reading' | 'settled' | 'failed';
export type DraftStatus = 'idle' | 'saving' | 'saved' | 'failed' | 'superseded';

/** One attachment chip's state (D3). `staged` is populated once staging
 * resolves (`settled`) and carries the Rust-owned id future removal/send
 * calls key off; `size`/`mimeType` are duplicated onto the descriptor
 * itself (rather than read only from `staged`) so a `reading` chip — which
 * has no `staged` result yet — can still render a filename immediately.
 * `assetUrl` is populated only for inline images the caret already
 * consumed, so removal can revoke the right staged part (FR "Inline
 * images"). */
export type ComposeAttachment = {
  /** Client-generated id, stable across the reading→settled/failed
   * transition — the Rust-issued `staged.id` only exists once settled, so
   * this is what removal/cancellation always keys off. */
  localId: string;
  filename: string;
  mimeType: string;
  size: number;
  state: AttachmentState;
  /** Set once staging resolves. */
  staged: { id: string; path: string; assetUrl: string; size: number } | null;
  /** Present only for an inline image already inserted at the caret —
   * distinguishes an attachment chip from an inline preview so removal
   * knows whether to also strip it from the editable body. */
  contentId: string | null;
  /** Scoped to this chip, never a toast (FR "Attachments and inline
   * images"). */
  error: string | null;
};

export type ComposeSession = {
  id: string;
  mode: ComposeMode;
  accountId: string;
  from: string;
  recipients: RecipientRoles;
  /** Cc/Bcc reveal together and, once revealed, persist for the rest of
   * this session even if both are emptied again. */
  ccBccRevealed: boolean;
  /** Count of chips hidden behind each role's "+N more" overflow control —
   * ephemeral layout state, not something Rust knows about, mirroring how
   * `dimensions` is owned here rather than persisted. */
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
  /** Commits typed text as a chip: trims, strips a trailing comma, and
   * suppresses a duplicate whose extracted address already appears in this
   * role's list, case-insensitively. A no-op for empty/duplicate input. */
  commitRecipient: (role: RecipientRole, raw: string) => void;
  removeRecipient: (role: RecipientRole, index: number) => void;
  /** Backspace-on-empty-input semantics: drops the last committed chip. */
  removeLastRecipient: (role: RecipientRole) => void;
  revealCcBcc: () => void;
  setOverflowCount: (role: RecipientRole, count: number) => void;
  toggleQuote: () => void;
  /** Adds a placeholder chip in the `reading` state immediately — before
   * staging resolves — so the strip reflects a pick/drop the instant it
   * happens rather than waiting on the IPC round trip. */
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
  /** Removes a chip regardless of state — a `reading` chip's "remove"
   * control is labelled Cancel, but the store-level effect is identical:
   * the local placeholder disappears, and a later `settleAttachment` for an
   * id no longer present is simply a no-op below. */
  removeAttachment: (localId: string) => void;
  setDraftStatus: (status: DraftStatus, error?: string | null) => void;
  setDraftId: (draftId: string) => void;
  markSaved: () => void;
};

/** Must match `--spacing-compose-min` in `index.css` — the panel clamps to
 * this on every axis, on open and on resize alike. */
export const COMPOSE_MIN_PX = 360;

/** Floors, matching `--spacing-compose-width` / `--spacing-compose-height`.
 * A panel never opens smaller than this unless the viewport itself forces
 * it. */
const COMPOSE_FLOOR = { width: 512, height: 500 };
/** Ceilings. Past these the composer stops being a panel over the mailbox
 * and starts being a window, which D8's non-modal design depends on it not
 * becoming. */
const COMPOSE_CEILING = { width: 840, height: 820 };
/** Fraction of the viewport the panel prefers to occupy between those
 * bounds, so a 4K display gets a usable composer instead of the same
 * 512px card that suits a laptop. */
const COMPOSE_VIEWPORT_FRACTION = { width: 0.42, height: 0.62 };
/** The bottom-right anchor's inset, doubled — the panel never fills the
 * viewport edge to edge. Matches `--spacing-container-padding`. */
const COMPOSE_VIEWPORT_INSET = 48;

function axis(viewport: number, floor: number, ceiling: number, fraction: number) {
  const preferred = Math.max(floor, Math.round(viewport * fraction));
  const available = Math.max(COMPOSE_MIN_PX, Math.min(ceiling, viewport - COMPOSE_VIEWPORT_INSET));
  return Math.min(preferred, available);
}

/** Read at open time rather than module load, so a composer opened after
 * the window was resized or moved to another display is sized for the
 * viewport it actually appears on. */
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
        // Cc/Bcc reveal together and persist for the session; a session
        // that already carries Cc or Bcc recipients at open time (a future
        // reply-all's derived Cc, or a reopened draft) starts revealed
        // rather than hiding data the user already has.
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
      // A cancelled/removed chip's staging call may still resolve later —
      // silently drop the result rather than resurrect a chip the user
      // already dismissed.
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

/** Send readiness derives from a committed To recipient — computed rather
 * than stored so Phase 5 can wire the Send control to it without changing
 * recipient semantics. */
export const selectHasCommittedRecipient = (state: ComposeStore) =>
  (state.session?.recipients.to.length ?? 0) > 0;

/** Send is additionally blocked while any attachment read is outstanding
 * (FR "Attachments and inline images") — exposed now as a pure selector so
 * Phase 5 can wire it into Send without re-deriving attachment state. */
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
