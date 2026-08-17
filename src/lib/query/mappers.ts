import { parseParticipant } from '@/lib/format/participants';
import { domainFor } from '@/lib/avatars/identity';
import { LABEL_COLOR_PALETTE, resolveLabelColorSwatch } from '@/lib/labels/palette';
import type { Conversation as IpcConversation, MailLabel, MailThread } from '@/lib/types/ipc';
import type { Conversation } from '@/lib/types/conversation';
import type { ReaderConversation } from '@/components/reader/ReadingPane';
import type { Mailbox } from '@/components/sidebar/FolderList';
import type { Label } from '@/components/sidebar/LabelList';
import type { LabelMenuEntry, LabelMembership } from '@/components/actions/LabelsMenu';

const FALLBACK_SWATCH = LABEL_COLOR_PALETTE[0];

export function mapThreadToRow(thread: MailThread): Conversation {
  const systemLabelIds = thread.systemLabelIds ?? [];
  const isSent = systemLabelIds.includes('SENT');
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
    systemLabelIds,
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

export function mapConversation(conversation: IpcConversation): ReaderConversation {
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
      labelIds: message.labelIds,
      unread: message.isUnread,
      starred: message.isStarred,
      remoteImagesBlocked: message.remoteImagesBlocked,
      isDraft: message.labelIds.includes('DRAFT'),
      draftId: message.draftId,
    })),
  };
}
