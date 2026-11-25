import type { ActionRibbonProps } from '@/components/actions/ActionRibbon';
import type { MessageExportActions } from '@/components/actions/MessageActionRibbon';
import type { MoveDestinationId } from '@/components/actions/MoveToMenu';
import { intersectAll } from '@/lib/collections';
import type { ComposeAction } from '@/lib/compose/entry';
import type { Participant } from '@/lib/format/participants';
import { saveMessageAs } from '@/lib/messages/save';
import { labelColorId } from '@/lib/query/mappers';
import type { MessageTriageIntent, ThreadTriageIntent } from '@/lib/query/mutations';
import { readToggleIntent, spamToggleIntent, starToggleIntent } from '@/lib/triage/intents';
import type { Conversation } from '@/lib/types/conversation';
import type { MailLabel, MailThread } from '@/lib/types/ipc';
import { useMessageSourceStore } from '@/stores/message-source';
import type { MessageRibbonProps, ReaderMessage } from './MessageCard';

const MOVE_DESTINATION_IDS: MoveDestinationId[] = ['INBOX', 'SPAM', 'TRASH'];

export type ReaderConversation = { id: string; subject: string; messages: ReaderMessage[] };

export type TriageHandlers = Pick<
  ActionRibbonProps,
  'onToggleRead' | 'onToggleStar' | 'onApplyLabels' | 'onMoveTo' | 'onToggleSpam' | 'onDelete'
>;

export type ReadingPaneBulkSelection = {
  count: number;
  selectedThreads: Conversation[];
  loadedThreadCount: number;
  moveToCurrentLabelIds?: MoveDestinationId[];
  onClearSelection: () => void;
  onSelectAll: () => void;
};

export type ReadingPaneTriageContext = {
  systemLabelIds: string[];
  labelMenuEntries: MessageRibbonProps['labels'];
  unread: boolean;
  starred: boolean;
  handlers: TriageHandlers;
  onMessageTriage?: (messageId: string, intent: MessageTriageIntent) => void;
};

export type ReadingPaneBodyContext = {
  onFetchBody?: (messageId: string) => void;
  loadingMessageId?: string;
  failedMessageId?: string;
  onLoadImages?: (messageId: string) => void;
  onTrustSender?: (address: string) => void;
};

export type ReadingPaneComposeContext = {
  onCompose?: (action: ComposeAction, messageId: string) => void;
  onComposeTo?: (participant: Participant) => void;
};

export type ReadingPaneProps = {
  threadId: string | null;
  conversation?: ReaderConversation;
  loading?: boolean;
  error?: boolean;
  accountId?: string | null;
  gmailThreadUrl?: string | null;
  bulkSelection?: ReadingPaneBulkSelection;
  triage?: ReadingPaneTriageContext;
  body?: ReadingPaneBodyContext;
  compose?: ReadingPaneComposeContext;
};

export const noTriageHandlers: TriageHandlers = {
  onToggleRead: () => undefined,
  onToggleStar: () => undefined,
  onApplyLabels: () => undefined,
  onMoveTo: () => undefined,
  onToggleSpam: () => undefined,
  onDelete: () => undefined,
};

export const DEFAULT_TRIAGE_CONTEXT: ReadingPaneTriageContext = {
  systemLabelIds: [],
  labelMenuEntries: [],
  unread: false,
  starred: false,
  handlers: noTriageHandlers,
};

export function intersectMessageLabelIds(messagesLabelIds: string[][]): string[] {
  return intersectAll(messagesLabelIds);
}

export function intersectThreadSystemLabelIds(threads: { systemLabelIds?: string[] }[]): string[] {
  return intersectAll(threads.map((thread) => thread.systemLabelIds ?? []));
}

function bulkMembershipFor(
  labelName: string,
  selectedThreads: { labelIndicators?: string[] }[],
): 'checked' | 'unchecked' | 'indeterminate' {
  if (selectedThreads.length === 0) return 'unchecked';
  const matchCount = selectedThreads.filter((thread) =>
    thread.labelIndicators?.includes(labelName),
  ).length;
  if (matchCount === 0) return 'unchecked';
  return matchCount === selectedThreads.length ? 'checked' : 'indeterminate';
}

function buildExportActions(
  accountId: string | null,
  subject: string,
  message: ReaderMessage,
): MessageExportActions | undefined {
  if (!accountId || message.isDraft) return undefined;
  const target = {
    accountId: accountId,
    messageId: message.id,
    subject: subject,
    sender: message.sender.address,
    sentAt: message.sentAt,
  };
  return {
    onShowOriginal: () =>
      useMessageSourceStore.getState().open({ accountId: accountId, messageId: message.id }),
    onDownloadEml: () => void saveMessageAs('eml', target),
    onDownloadHtml: () => void saveMessageAs('html', target),
  };
}

export function buildMessageRibbon(input: {
  base: MessageRibbonProps;
  message: ReaderMessage;
  accountId: string | null;
  subject: string;
  onMessageTriage?: (messageId: string, intent: MessageTriageIntent) => void;
  onCompose?: (action: ComposeAction, messageId: string) => void;
}): MessageRibbonProps {
  const { base, message, accountId, subject, onMessageTriage, onCompose } = input;
  const labelIds = message.labelIds ?? [];
  return {
    ...base,
    systemLabelIds: labelIds,
    onApplyLabels: (changes) => onMessageTriage?.(message.id, { kind: 'label', ...changes }),
    onMoveTo: (destination) =>
      onMessageTriage?.(message.id, { kind: 'move', destination: destination }),
    onToggleSpam: () => onMessageTriage?.(message.id, spamToggleIntent(labelIds.includes('SPAM'))),
    onDelete: () => onMessageTriage?.(message.id, { kind: 'delete' }),
    onReply: () => onCompose?.('reply', message.id),
    onReplyAll: () => onCompose?.('reply-all', message.id),
    onForward: () => onCompose?.('forward', message.id),
    onEditDraft: message.isDraft ? () => onCompose?.('edit-draft', message.id) : undefined,
    exportActions: buildExportActions(accountId, subject, message),
  };
}

export function resolveThreadSystemLabelIds(
  provided: string[] | undefined,
  conversation: ReaderConversation,
): string[] {
  if (provided) return provided;
  return intersectMessageLabelIds(conversation.messages.map((message) => message.labelIds ?? []));
}

export function defaultMessageRibbonBase(
  labels: MessageRibbonProps['labels'],
  threadHandlers: TriageHandlers,
): MessageRibbonProps {
  return {
    systemLabelIds: [],
    labels: labels,
    ...threadHandlers,
    onReply: () => undefined,
    onReplyAll: () => undefined,
    onForward: () => undefined,
  };
}

export function triageHandlersFor({
  threadIds,
  unread,
  starred,
  isSpam,
  mutate,
}: {
  threadIds: string[];
  unread: boolean;
  starred: boolean;
  isSpam: boolean;
  mutate: (threadIds: string[], intent: ThreadTriageIntent) => void;
}): TriageHandlers {
  return {
    onToggleRead: () => mutate(threadIds, readToggleIntent(unread)),
    onToggleStar: () => mutate(threadIds, starToggleIntent(starred)),
    onApplyLabels: ({ add, remove }: { add: string[]; remove: string[] }) =>
      mutate(threadIds, { kind: 'label', add: add, remove: remove }),
    onMoveTo: (destination: 'INBOX' | 'SPAM' | 'TRASH') =>
      mutate(threadIds, { kind: 'move', destination: destination }),
    onToggleSpam: () => mutate(threadIds, spamToggleIntent(isSpam)),
    onDelete: () => mutate(threadIds, { kind: 'delete' }),
  };
}

export function resolveActiveIds(
  multiSelectActive: boolean,
  selectedIds: ReadonlySet<string>,
  threadId: string | null,
): string[] {
  if (multiSelectActive) return [...selectedIds];
  return threadId ? [threadId] : [];
}

export function buildBulkLabelMenuEntries(
  labels: MailLabel[],
  selectedThreads: { labelIndicators?: string[] }[],
): MessageRibbonProps['labels'] {
  return labels
    .filter((label) => label.kind === 'user')
    .map((label) => ({
      id: label.id,
      name: label.name,
      color: labelColorId(label),
      membership: bulkMembershipFor(label.name, selectedThreads),
    }));
}

export function resolveMoveToCurrentLabelIds(
  multiSelectActive: boolean,
  selectedThreads: { systemLabelIds?: string[] }[],
): MoveDestinationId[] | undefined {
  if (!multiSelectActive) return undefined;
  if (selectedThreads.length === 0) return [];
  return MOVE_DESTINATION_IDS.filter((id) =>
    selectedThreads.every((thread) => (thread.systemLabelIds ?? []).includes(id)),
  );
}

export function deriveReaderTriageSummary(input: {
  multiSelectActive: boolean;
  selectedThreads: MailThread[];
  conversation: ReaderConversation | undefined;
}) {
  if (input.multiSelectActive) {
    return {
      unread: input.selectedThreads.some((thread) => thread.isUnread),
      starred: input.selectedThreads.some((thread) => thread.isStarred),
      systemLabelIds: intersectThreadSystemLabelIds(input.selectedThreads),
    };
  }
  const messages = input.conversation?.messages ?? [];
  return {
    unread: messages.some((message) => message.unread),
    starred: messages.some((message) => message.starred),
    systemLabelIds: intersectMessageLabelIds(messages.map((message) => message.labelIds ?? [])),
  };
}
