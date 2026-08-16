// Pure mappers from Rust-sourced IPC DTOs (src/lib/types/ipc.ts) onto the
// presentational shapes the list/reader components already render
// (src/lib/types/conversation.ts, src/components/reader/ReadingPane.tsx).
// Kept separate from the fetching hooks so both stay easy to unit test.
import { parseParticipant } from '@/lib/format/participants';
import { domainFor } from '@/lib/avatars/identity';
import { LABEL_COLOR_PALETTE, resolveLabelColorSwatch } from '@/lib/labels/palette';
import type { Conversation as IpcConversation, MailLabel, MailThread } from '@/lib/types/ipc';
import type { Conversation } from '@/lib/types/conversation';
import type { ReaderConversation } from '@/components/reader/ReadingPane';
import type { Mailbox } from '@/components/sidebar/FolderList';
import type { Label } from '@/components/sidebar/LabelList';
import type { LabelMenuEntry, LabelMembership } from '@/components/actions/LabelsMenu';

// A label whose colour Gmail hasn't set yet (or set to a pair outside this
// app's curated palette — see `lib/labels/palette.ts`) falls back to the
// first swatch rather than rendering colourless.
const FALLBACK_SWATCH = LABEL_COLOR_PALETTE[0];

/** `mailboxId` picks which of the two Rust-resolved identities the row
 * names: the Sent mailbox names and depicts the recipient, everyone else the
 * newest sender (D12/D13). `thread.sender.display` is always a finished,
 * ready-to-render string with Rust's own fallback already applied. The Sent
 * side's identity is `null` only when the thread has no Sent-labelled
 * message at all — TS supplies its own "(No recipient)" fallback for that
 * case, since Rust never computed anything to fall back from. */
export function mapThreadToRow(thread: MailThread, mailboxId?: string | null): Conversation {
  const isSent = mailboxId === 'SENT';
  const identity = isSent ? thread.sentRecipient : thread.sender;
  const label = identity?.display ?? null;
  const address = identity?.address ?? null;
  const sender = isSent ? (label ? `To: ${label}` : '(No recipient)') : (label ?? '(No sender)');
  return {
    id: thread.id,
    sender,
    identityLabel: label,
    avatarDomain: domainFor(address),
    subject: thread.subject || '(No subject)',
    snippet: thread.snippet ?? '',
    date: new Date(thread.latestAt),
    unread: thread.isUnread,
    starred: thread.isStarred,
    hasAttachment: thread.hasAttachments,
    messageCount: thread.messageCount,
    draft: thread.hasDraft,
    labels: thread.labelIndicators ?? [],
  };
}

export function mapLabelsToMailboxes(labels: MailLabel[]): Mailbox[] {
  return labels.map((label) => ({
    id: label.id,
    name: label.name,
    unreadCount: label.unreadCount,
  }));
}

export function mapLabelsToUserLabels(labels: MailLabel[]): Label[] {
  return labels
    .filter((label) => label.kind === 'user')
    .map((label) => ({
      id: label.id,
      name: label.name,
      unreadCount: label.unreadCount,
      color: (resolveLabelColorSwatch(label.color) ?? FALLBACK_SWATCH).id,
    }));
}

/** Union-based thread-level membership (FR "Labels menu semantics"): a
 * label on every message is `checked`, on none is `unchecked`, and on some
 * but not all is `indeterminate` — the tri-state the staged `LabelsMenu`
 * exposes as `aria-checked="mixed"`. `messagesLabelIds` is empty only for a
 * thread with no messages yet loaded, in which case everything renders
 * `unchecked` rather than throwing on an empty reduce. */
export function computeThreadLabelMembership(
  labels: MailLabel[],
  messagesLabelIds: string[][],
): LabelMenuEntry[] {
  return labels
    .filter((label) => label.kind === 'user')
    .map((label) => {
      const presentCount = messagesLabelIds.filter((ids) => ids.includes(label.id)).length;
      const membership: LabelMembership =
        messagesLabelIds.length === 0 || presentCount === 0
          ? 'unchecked'
          : presentCount === messagesLabelIds.length
            ? 'checked'
            : 'indeterminate';
      return {
        id: label.id,
        name: label.name,
        color: (resolveLabelColorSwatch(label.color) ?? FALLBACK_SWATCH).id,
        membership,
      };
    });
}

export function mapConversation(
  conversation: IpcConversation,
  labelNamesById: Map<string, string>,
): ReaderConversation {
  return {
    id: conversation.threadId,
    subject: conversation.subject,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      sender: parseParticipant(message.sender),
      recipients: message.recipients.map(parseParticipant),
      toRecipients: (message.toRecipients ?? message.recipients).map(parseParticipant),
      ccRecipients: (message.ccRecipients ?? []).map(parseParticipant),
      bccRecipients: (message.bccRecipients ?? []).map(parseParticipant),
      sentAt: new Date(message.sentAt),
      snippet: message.snippet,
      html: message.htmlBody,
      htmlPresence: message.htmlPresence,
      text: message.plainBody,
      labels: message.labelIds
        .map((id) => labelNamesById.get(id))
        .filter((name): name is string => Boolean(name)),
      labelIds: message.labelIds,
      unread: message.isUnread,
      starred: message.isStarred,
      remoteImagesBlocked: message.remoteImagesBlocked,
      isDraft: message.labelIds.includes('DRAFT'),
      draftId: message.draftId,
    })),
  };
}
