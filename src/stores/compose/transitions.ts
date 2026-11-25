import { addressKey } from '@/lib/format/participants';
import type {
  ComposeAttachment,
  ComposeDimensions,
  ComposeSession,
  DraftStatus,
  OpenComposeArgs,
  ReadingAttachmentInput,
  RecipientRole,
  StagedAttachmentInfo,
} from '../compose';

export const COMPOSE_MIN_PX = 360;

const COMPOSE_FLOOR = { width: 512, height: 500 };
const COMPOSE_CEILING = { width: 840, height: 820 };
const COMPOSE_VIEWPORT_FRACTION = { width: 0.42, height: 0.62 };
const COMPOSE_VIEWPORT_INSET = 48;

const DEFAULT_OVERFLOW: Record<RecipientRole, number> = { to: 0, cc: 0, bcc: 0 };

type AxisBounds = {
  viewport: number;
  floor: number;
  ceiling: number;
  fraction: number;
};

function computeAxis(bounds: AxisBounds): number {
  const preferred = Math.max(bounds.floor, Math.round(bounds.viewport * bounds.fraction));
  const available = Math.max(
    COMPOSE_MIN_PX,
    Math.min(bounds.ceiling, bounds.viewport - COMPOSE_VIEWPORT_INSET),
  );
  return Math.min(preferred, available);
}

function initialDimensions(): ComposeDimensions {
  return {
    width: computeAxis({
      viewport: window.innerWidth,
      floor: COMPOSE_FLOOR.width,
      ceiling: COMPOSE_CEILING.width,
      fraction: COMPOSE_VIEWPORT_FRACTION.width,
    }),
    height: computeAxis({
      viewport: window.innerHeight,
      floor: COMPOSE_FLOOR.height,
      ceiling: COMPOSE_CEILING.height,
      fraction: COMPOSE_VIEWPORT_FRACTION.height,
    }),
  };
}

function normalizeRecipient(raw: string): string | null {
  const trimmed = raw.trim().replace(/,+$/, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildThreadingFields(session: OpenComposeArgs) {
  return {
    draftId: session.draftId ?? null,
    threadId: session.threadId ?? null,
    inReplyTo: session.inReplyTo ?? null,
    references: session.references ?? [],
    originalMessageId: session.originalMessageId ?? null,
    originalGmailMessageId: session.originalGmailMessageId ?? null,
  };
}

export function createComposeSession(session: OpenComposeArgs): ComposeSession {
  const hasSecondaryRecipients =
    session.recipients.cc.length > 0 || session.recipients.bcc.length > 0;
  return {
    ...session,
    dirty: false,
    ccBccRevealed: hasSecondaryRecipients,
    overflow: { ...DEFAULT_OVERFLOW },
    quote: session.quote ?? null,
    quoteOpen: false,
    dimensions: session.dimensions ?? initialDimensions(),
    attachments: session.attachments ?? [],
    ...buildThreadingFields(session),
    draftStatus: 'idle',
    lifecycleError: null,
  };
}

export function commitRecipientToSession(
  session: ComposeSession,
  input: { role: RecipientRole; raw: string },
): ComposeSession {
  const recipient = normalizeRecipient(input.raw);
  if (!recipient) return session;
  const existing = session.recipients[input.role];
  const key = addressKey(recipient);
  if (existing.some((entry) => addressKey(entry) === key)) return session;
  return {
    ...session,
    recipients: { ...session.recipients, [input.role]: [...existing, recipient] },
    dirty: true,
  };
}

export function removeRecipientFromSession(
  session: ComposeSession,
  input: { role: RecipientRole; index: number },
): ComposeSession {
  return {
    ...session,
    recipients: {
      ...session.recipients,
      [input.role]: session.recipients[input.role].filter(
        (_entry, entryIndex) => entryIndex !== input.index,
      ),
    },
    dirty: true,
  };
}

export function removeLastRecipientFromSession(
  session: ComposeSession,
  role: RecipientRole,
): ComposeSession {
  if (session.recipients[role].length === 0) return session;
  return {
    ...session,
    recipients: {
      ...session.recipients,
      [role]: session.recipients[role].slice(0, -1),
    },
    dirty: true,
  };
}

export function addReadingAttachmentToSession(
  session: ComposeSession,
  input: ReadingAttachmentInput,
): ComposeSession {
  const attachment: ComposeAttachment = {
    localId: input.localId,
    filename: input.filename,
    mimeType: input.mimeType,
    size: 0,
    state: 'reading',
    staged: null,
    contentId: input.contentId,
    error: null,
  };
  return {
    ...session,
    attachments: [...session.attachments, attachment],
    dirty: true,
  };
}

export function settleAttachmentInSession(
  session: ComposeSession,
  input: { localId: string; staged: StagedAttachmentInfo },
): ComposeSession {
  const matches = session.attachments.some((entry) => entry.localId === input.localId);
  if (!matches) return session;
  return {
    ...session,
    attachments: session.attachments.map((entry) =>
      entry.localId === input.localId
        ? {
            ...entry,
            state: 'settled',
            staged: input.staged,
            size: input.staged.size,
            error: null,
          }
        : entry,
    ),
  };
}

export function failAttachmentInSession(
  session: ComposeSession,
  input: { localId: string; error: string },
): ComposeSession {
  const matches = session.attachments.some((entry) => entry.localId === input.localId);
  if (!matches) return session;
  return {
    ...session,
    attachments: session.attachments.map((entry) =>
      entry.localId === input.localId ? { ...entry, state: 'failed', error: input.error } : entry,
    ),
  };
}

export function removeAttachmentFromSession(
  session: ComposeSession,
  localId: string,
): ComposeSession {
  return {
    ...session,
    attachments: session.attachments.filter((entry) => entry.localId !== localId),
    dirty: true,
  };
}

export function setSessionDraftStatus(
  session: ComposeSession,
  input: { draftStatus: DraftStatus; lifecycleError: string | null },
): ComposeSession {
  return {
    ...session,
    draftStatus: input.draftStatus,
    lifecycleError: input.lifecycleError,
  };
}

export function markSessionSaved(session: ComposeSession): ComposeSession {
  return {
    ...session,
    dirty: false,
    draftStatus: 'saved',
    lifecycleError: null,
  };
}
