import { invoke } from '@/lib/ipc/commands';
import { toDraftRequest } from '@/lib/compose/autosave';
import type { Participant } from '@/lib/format/participants';
import type { ReaderMessage } from '@/components/reader/MessageCard';
import { useComposeStore, type ComposeMode, type OpenComposeArgs } from '@/stores/compose';

function formatRaw(participant: Participant): string {
  return participant.name ? `${participant.name} <${participant.address}>` : participant.address;
}

function openOrRetarget(args: OpenComposeArgs): void {
  const state = useComposeStore.getState();
  if (state.session?.dirty) {
    void invoke('save_compose_draft', { draft: toDraftRequest(state.session) });
  }
  state.open(args);
}

function baseSession(
  mode: ComposeMode,
  accountId: string,
  accountEmail: string,
): Pick<OpenComposeArgs, 'id' | 'mode' | 'accountId' | 'from'> {
  return { id: crypto.randomUUID(), mode, accountId, from: accountEmail };
}

export async function openReply(
  mode: 'reply' | 'reply-all',
  accountId: string,
  accountEmail: string,
  message: ReaderMessage | undefined,
): Promise<void> {
  if (!message) return;
  const context = await invoke('reply_context', {
    accountId,
    messageId: message.id,
    accountEmail,
    replyAll: mode === 'reply-all',
    forward: false,
  });
  openOrRetarget({
    ...baseSession(mode, accountId, accountEmail),
    recipients: { to: context.to, cc: context.cc, bcc: [] },
    subject: context.subject,
    html: '',
    quote: context.displayQuote,
    threadId: context.targetThreadId,
    inReplyTo: context.inReplyTo,
    references: context.references,
    originalMessageId: context.originalMessageId,
    originalGmailMessageId: context.originalGmailMessageId,
  });
}

export async function openForward(
  accountId: string,
  accountEmail: string,
  message: ReaderMessage | undefined,
): Promise<void> {
  if (!message) return;
  const context = await invoke('reply_context', {
    accountId,
    messageId: message.id,
    accountEmail,
    replyAll: false,
    forward: true,
  });
  openOrRetarget({
    ...baseSession('forward', accountId, accountEmail),
    recipients: { to: [], cc: [], bcc: [] },
    subject: context.subject,
    html: '',
    quote: context.displayQuote,
    originalMessageId: context.originalMessageId,
    originalGmailMessageId: context.originalGmailMessageId,
  });
}

export function openNewMessage(
  accountId: string,
  accountEmail: string,
  presetTo?: Participant,
): void {
  openOrRetarget({
    ...baseSession('new', accountId, accountEmail),
    recipients: { to: presetTo ? [formatRaw(presetTo)] : [], cc: [], bcc: [] },
    subject: '',
    html: '',
  });
}

export async function openEditDraft(
  accountId: string,
  accountEmail: string,
  subject: string,
  message: ReaderMessage | undefined,
): Promise<void> {
  if (!message) return;
  const draftId = message.draftId;
  if (draftId) {
    const draft = await invoke('hydrate_compose_draft', { accountId, draftId });
    openOrRetarget({
      id: draft.sessionId,
      mode: draft.mode as ComposeMode,
      accountId,
      from: draft.from,
      recipients: { to: draft.to, cc: draft.cc, bcc: draft.bcc },
      subject: draft.subject,
      html: draft.html,
      quote: draft.quoteHtml ? { html: draft.quoteHtml, attribution: 'Quoted original' } : null,
      draftId: draft.draftId,
      threadId: draft.threadId,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      originalMessageId: draft.originalMessageId,
      originalGmailMessageId: draft.originalGmailMessageId,
      attachments: draft.attachments.map((part) => ({
        localId: part.id,
        filename: part.filename,
        mimeType: part.mimeType,
        size: part.size,
        state: 'settled',
        staged: { id: part.id, path: part.path, assetUrl: part.path, size: part.size },
        contentId: part.contentId,
        error: null,
      })),
    });
    return;
  }
  openOrRetarget({
    ...baseSession('draft', accountId, accountEmail),
    recipients: {
      to: (message.toRecipients ?? message.recipients).map(formatRaw),
      cc: (message.ccRecipients ?? []).map(formatRaw),
      bcc: (message.bccRecipients ?? []).map(formatRaw),
    },
    subject,
    html: message.html ?? '',
  });
}
