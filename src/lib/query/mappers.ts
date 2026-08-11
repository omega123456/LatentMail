// Pure mappers from Rust-sourced IPC DTOs (src/lib/types/ipc.ts) onto the
// presentational shapes the list/reader components already render
// (src/lib/types/conversation.ts, src/components/reader/ReadingPane.tsx).
// Kept separate from the fetching hooks so both stay easy to unit test.
import { parseParticipant } from '@/lib/format/participants';
import type { Conversation as IpcConversation, MailLabel, MailThread } from '@/lib/types/ipc';
import type { Conversation } from '@/lib/types/conversation';
import type { ReaderConversation } from '@/components/reader/ReadingPane';
import type { Mailbox } from '@/components/sidebar/FolderList';
import type { Label } from '@/components/sidebar/LabelList';

export function mapThreadToRow(thread: MailThread): Conversation {
  return {
    id: thread.id,
    sender: thread.participants.join(', ') || '(No sender)',
    subject: thread.subject || '(No subject)',
    // ThreadDto carries no snippet field (Phase 17's IPC surface) — the
    // spacious-density snippet line renders blank for real data until a
    // future phase extends the DTO.
    snippet: '',
    date: new Date(thread.latestAt),
    unread: thread.isUnread,
    starred: thread.isStarred,
    hasAttachment: thread.hasAttachments,
    messageCount: thread.messageCount,
    draft: thread.hasDraft,
  };
}

const labelColors: Label['color'][] = ['blue', 'green', 'orange'];

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
    .map((label, index) => ({
      id: label.id,
      name: label.name,
      unreadCount: label.unreadCount,
      color: labelColors[index % labelColors.length],
    }));
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
      sentAt: new Date(message.sentAt),
      snippet: message.snippet,
      html: message.htmlBody,
      text: message.plainBody,
      labels: message.labelIds
        .map((id) => labelNamesById.get(id))
        .filter((name): name is string => Boolean(name)),
    })),
  };
}
