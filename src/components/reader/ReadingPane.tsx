import { parseISO } from 'date-fns';
import { useMemo } from 'react';
import { ActionRibbon, type ActionRibbonProps } from '@/components/actions/ActionRibbon';
import { BulkSelectionPanel } from '@/components/actions/BulkSelectionPanel';
import type { MessageExportActions } from '@/components/actions/MessageActionRibbon';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { LoadingState } from '@/components/states/LoadingState';
import { openComposeAction, openNewMessage, type ComposeAction } from '@/lib/compose/entry';
import { intersectAll } from '@/lib/collections';
import { readToggleIntent, spamToggleIntent, starToggleIntent } from '@/lib/triage/intents';
import {
  useAccountsQuery,
  useConversationQuery,
  useFetchMessageBodyMutation,
  useLabelsQuery,
  useSearchThreadsQuery,
  useThreadsQuery,
} from '@/lib/query/hooks';
import {
  useMessageTriageIntentMutation,
  useThreadTriageIntentMutation,
  type MessageTriageIntent,
  type ThreadTriageIntent,
} from '@/lib/query/mutations';
import { buildGmailThreadWebUrl } from '@/lib/gmail/thread-url';
import { messageBadges } from '@/lib/labels/badges';
import { saveMessageAs } from '@/lib/messages/save';
import {
  computeThreadLabelMembership,
  labelColorId,
  mapConversation,
  mapThreadToRow,
} from '@/lib/query/mappers';
import type { Conversation } from '@/lib/types/conversation';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useLayoutStore } from '@/stores/layout';
import { useMessageSourceStore } from '@/stores/message-source';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import type { MoveDestinationId } from '@/components/actions/MoveToMenu';
import { MessageCard, type MessageRibbonProps, type ReaderMessage } from './MessageCard';
import { ReaderContextMenu } from './ReaderContextMenu';

const MOVE_DESTINATION_IDS: MoveDestinationId[] = ['INBOX', 'SPAM', 'TRASH'];

function intersectMessageLabelIds(messagesLabelIds: string[][]): string[] {
  return intersectAll(messagesLabelIds);
}

function intersectThreadSystemLabelIds(threads: { systemLabelIds?: string[] }[]): string[] {
  return intersectAll(threads.map((thread) => thread.systemLabelIds ?? []));
}

export type ReaderConversation = { id: string; subject: string; messages: ReaderMessage[] };
type TriageHandlers = Pick<
  ActionRibbonProps,
  'onToggleRead' | 'onToggleStar' | 'onApplyLabels' | 'onMoveTo' | 'onToggleSpam' | 'onDelete'
>;
export type { ComposeAction };

export const readerFixtures: Record<string, ReaderConversation> = {
  'thread-1': {
    id: 'thread-1',
    subject: 'Q3 Marketing Strategy Review',
    messages: [
      {
        id: 'message-1',
        sender: { name: 'Elena Rodriguez', address: 'elena.r@example.com' },
        recipients: [
          { name: 'You', address: 'you@example.com' },
          { name: 'Alex', address: 'alex@example.com' },
          { name: 'Sam', address: 'sam@example.com' },
        ],
        sentAt: parseISO('2026-08-10T09:00:00Z'),
        snippet: "I've attached the finalized slides for tomorrow's presentation.",
        html: "<p>I've attached the finalized slides for tomorrow's presentation.</p>",
        text: null,
      },
      {
        id: 'message-2',
        sender: { name: 'Elena Rodriguez', address: 'elena.r@example.com' },
        recipients: [
          { name: 'You', address: 'you@example.com' },
          { name: 'David', address: 'david@example.com' },
          { name: 'Sarah', address: 'sarah@example.com' },
        ],
        sentAt: parseISO('2026-08-11T09:00:00Z'),
        snippet:
          "I've attached the finalized slide deck for tomorrow's Q3 Marketing Strategy presentation.",
        html: "<p>Hi Team,</p><p>I hope you're all having a great week.</p><p>I've attached the finalized slide deck for tomorrow's Q3 Marketing Strategy presentation. I've incorporated the feedback from last Thursday's sync, specifically around our digital spend allocation and the revised timeline for the social campaign launch.</p><p><strong>Please pay special attention to:</strong></p><ul><li>Slide 12: Budget reallocation from traditional to digital channels.</li><li>Slide 15: The revised KPI targets for Q3 (we bumped up the conversion goal by 5%).</li><li>Slide 20: The updated creative assets preview.</li></ul><p>Let me know if you spot any glaring errors or if we need to adjust the narrative flow before we present to the executive board. I'll be online for the next few hours to make any final tweaks.</p><p>Best regards,</p><p><strong>Elena Rodriguez</strong><br>Director of Marketing | Ethereal Corp<br>elena.r@ethereal.example.com</p>",
        text: null,
        labelIds: ['INBOX'],
        remoteImagesBlocked: true,
      },
    ],
  },
};

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

function resolveReadingPanePlaceholder(input: {
  threadId: string | null;
  loading: boolean;
  error: boolean;
  conversation: ReaderConversation | undefined;
}) {
  if (!input.threadId) return <EmptyState>Select a conversation to read it.</EmptyState>;
  if (input.loading) return <LoadingState>Loading conversation…</LoadingState>;
  if (input.error) return <ErrorState>Could not load this conversation.</ErrorState>;
  if (!input.conversation) return <EmptyState>Conversation unavailable.</EmptyState>;
  return null;
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

function buildMessageRibbon(input: {
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

function resolveThreadSystemLabelIds(
  provided: string[] | undefined,
  conversation: ReaderConversation,
): string[] {
  if (provided) return provided;
  return intersectMessageLabelIds(conversation.messages.map((message) => message.labelIds ?? []));
}

function defaultMessageRibbonBase(
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

function resolveConversation(
  provided: ReaderConversation | undefined,
  threadId: string | null,
): ReaderConversation | undefined {
  if (provided !== undefined) return provided;
  return threadId ? readerFixtures[threadId] : undefined;
}

type ReadingPaneProps = {
  threadId: string | null;
  conversation?: ReaderConversation;
  loading?: boolean;
  error?: boolean;
  systemLabelIds?: string[];
  moveToCurrentLabelIds?: string[];
  labelMenuEntries?: MessageRibbonProps['labels'];
  selectedCount?: number;
  selectedThreads?: Conversation[];
  loadedThreadCount?: number;
  onClearSelection?: () => void;
  onSelectAll?: () => void;
  unread?: boolean;
  starred?: boolean;
  onCompose?: (action: ComposeAction, messageId: string) => void;
  onComposeTo?: (participant: import('@/lib/format/participants').Participant) => void;
  triageHandlers?: TriageHandlers;
  onFetchBody?: (messageId: string) => void;
  loadingMessageId?: string;
  failedMessageId?: string;
  onMessageTriage?: (messageId: string, intent: MessageTriageIntent) => void;
  onLoadImages?: (messageId: string) => void;
  onTrustSender?: (address: string) => void;
  gmailThreadUrl?: string | null;
  accountId?: string | null;
};

function bulkSelectionFlags(props: ReadingPaneProps) {
  return {
    systemLabelIds: props.systemLabelIds ?? [],
    moveToCurrentLabelIds: props.moveToCurrentLabelIds,
    unread: props.unread ?? false,
    starred: props.starred ?? false,
    labels: props.labelMenuEntries ?? [],
  };
}

function renderBulkSelection(props: ReadingPaneProps) {
  return (
    <BulkSelectionPanel
      count={props.selectedCount ?? 0}
      selectedThreads={props.selectedThreads ?? []}
      loadedThreadCount={props.loadedThreadCount ?? 0}
      onClearSelection={props.onClearSelection ?? noop}
      onSelectAll={props.onSelectAll ?? noop}
      {...bulkSelectionFlags(props)}
      {...(props.triageHandlers ?? noTriageHandlers)}
    />
  );
}

function ConversationView({
  conversation,
  props,
}: {
  conversation: ReaderConversation;
  props: ReadingPaneProps;
}) {
  const labelMenuEntries = props.labelMenuEntries ?? [];
  const threadHandlers = props.triageHandlers ?? noTriageHandlers;
  const lastMessage = conversation.messages.at(-1);
  const composeThread = (action: ComposeAction) => {
    if (lastMessage) props.onCompose?.(action, lastMessage.id);
  };
  const messageRibbonBase = defaultMessageRibbonBase(labelMenuEntries, threadHandlers);
  return (
    <ReaderContextMenu>
      <section
        aria-label="Reading pane"
        className="h-full overflow-auto bg-surface-bright p-stack-gap-md dark:bg-dark-surface-container-high"
        data-testid="reading-pane"
      >
        <div className="min-h-full w-full rounded-md border border-outline-variant/20 bg-surface-container-lowest p-8 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest">
          <h1 className="mb-container-padding select-text text-display-sm leading-tight text-on-surface dark:text-dark-on-surface">
            {conversation.subject}
          </h1>
          <div className="mb-container-padding">
            <ActionRibbon
              systemLabelIds={resolveThreadSystemLabelIds(props.systemLabelIds, conversation)}
              unread={conversation.messages.some((message) => message.unread)}
              starred={conversation.messages.some((message) => message.starred)}
              labels={labelMenuEntries}
              {...threadHandlers}
              onReply={() => composeThread('reply')}
              onReplyAll={() => composeThread('reply-all')}
              onForward={() => composeThread('forward')}
              onEditDraft={lastMessage?.isDraft ? () => composeThread('edit-draft') : undefined}
            />
          </div>
          {conversation.messages.map((message, index) => (
            <MessageCard
              key={message.id}
              message={message}
              expanded={index === conversation.messages.length - 1}
              newest={index === conversation.messages.length - 1}
              badges={messageBadges(message, labelMenuEntries)}
              ribbon={buildMessageRibbon({
                base: messageRibbonBase,
                message: message,
                accountId: props.accountId ?? null,
                subject: conversation.subject,
                onMessageTriage: props.onMessageTriage,
                onCompose: props.onCompose,
              })}
              onFetchBody={props.onFetchBody}
              onComposeTo={props.onComposeTo}
              onLoadImages={props.onLoadImages}
              onTrustSender={props.onTrustSender}
              loadingBody={props.loadingMessageId === message.id}
              bodyError={props.failedMessageId === message.id}
              gmailThreadUrl={props.gmailThreadUrl ?? null}
              accountId={props.accountId ?? null}
            />
          ))}
        </div>
      </section>
    </ReaderContextMenu>
  );
}

export function ReadingPane(props: ReadingPaneProps) {
  if ((props.selectedCount ?? 0) > 0) return renderBulkSelection(props);
  const conversation = resolveConversation(props.conversation, props.threadId);
  const placeholder = resolveReadingPanePlaceholder({
    threadId: props.threadId,
    loading: props.loading ?? false,
    error: props.error ?? false,
    conversation: conversation,
  });
  if (placeholder || !conversation) return placeholder;
  return <ConversationView conversation={conversation} props={props} />;
}

function noop() {
  return undefined;
}

const noTriageHandlers: TriageHandlers = {
  onToggleRead: () => undefined,
  onToggleStar: () => undefined,
  onApplyLabels: () => undefined,
  onMoveTo: () => undefined,
  onToggleSpam: () => undefined,
  onDelete: () => undefined,
};

function triageHandlersFor(
  threadIds: string[],
  unread: boolean,
  starred: boolean,
  isSpam: boolean,
  mutate: (threadIds: string[], intent: ThreadTriageIntent) => void,
) {
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

function resolveActiveIds(
  multiSelectActive: boolean,
  selectedIds: ReadonlySet<string>,
  threadId: string | null,
): string[] {
  if (multiSelectActive) return [...selectedIds];
  return threadId ? [threadId] : [];
}

function buildBulkLabelMenuEntries(
  labels: import('@/lib/types/ipc').MailLabel[],
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

function resolveMoveToCurrentLabelIds(
  multiSelectActive: boolean,
  selectedThreads: { systemLabelIds?: string[] }[],
): MoveDestinationId[] | undefined {
  if (!multiSelectActive) return undefined;
  if (selectedThreads.length === 0) return [];
  return MOVE_DESTINATION_IDS.filter((id) =>
    selectedThreads.every((thread) => (thread.systemLabelIds ?? []).includes(id)),
  );
}

function deriveReaderTriageSummary(input: {
  multiSelectActive: boolean;
  selectedThreads: import('@/lib/types/ipc').MailThread[];
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

function useReaderAccountEmail(accountId: string | null): string {
  const accountsQuery = useAccountsQuery();
  return accountsQuery.data?.find((account) => account.id === accountId)?.email ?? '';
}

function useLoadedThreads(accountId: string | null, mailboxId: string) {
  const searchActive = useSearchStore((search) => search.active);
  const searchQuery = useSearchStore((search) => search.submittedQuery);
  const searchScope = useSearchStore((search) => search.scope);
  const threadsQuery = useThreadsQuery(accountId, mailboxId);
  const searchResultsQuery = useSearchThreadsQuery(accountId, searchQuery, searchScope);
  const activeThreadsQuery = searchActive ? searchResultsQuery : threadsQuery;
  return useMemo(
    () => (activeThreadsQuery.data?.pages ?? []).flatMap((page) => page.items),
    [activeThreadsQuery.data],
  );
}

export function ReadingPaneContainer({ threadId }: { threadId: string | null }) {
  const accountId = useSelectionStore((selection) => selection.activeAccountId);
  const mailboxId = useSelectionStore((selection) => selection.activeMailboxId) ?? 'INBOX';
  const allowImagesFor = useSelectionStore((selection) => selection.allowImagesFor);
  const trustImageSender = useLayoutStore((layout) => layout.trustImageSender);
  const accountEmail = useReaderAccountEmail(accountId);
  const selectedIds = useMultiSelectStore((multiSelect) => multiSelect.selectedIds);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);
  const clearSelection = useMultiSelectStore((multiSelect) => multiSelect.clear);
  const selectAll = useMultiSelectStore((multiSelect) => multiSelect.selectAll);
  const conversationQuery = useConversationQuery(accountId, multiSelectActive ? null : threadId);
  const fetchBody = useFetchMessageBodyMutation(accountId);
  const triage = useThreadTriageIntentMutation(accountId);
  const messageTriage = useMessageTriageIntentMutation(accountId);
  const labelsQuery = useLabelsQuery(accountId);
  const loadedThreads = useLoadedThreads(accountId, mailboxId);
  const conversation = conversationQuery.data ? mapConversation(conversationQuery.data) : undefined;
  const selectedThreads = useMemo(
    () => loadedThreads.filter((thread) => selectedIds.has(thread.id)),
    [selectedIds, loadedThreads],
  );
  const selectedRows = useMemo<Conversation[]>(
    () => selectedThreads.map(mapThreadToRow),
    [selectedThreads],
  );
  const labelMenuEntries = useMemo(() => {
    const labels = labelsQuery.data ?? [];
    if (multiSelectActive) return buildBulkLabelMenuEntries(labels, selectedThreads);
    const messageLabels = conversation?.messages.map((message) => message.labelIds ?? []) ?? [];
    return computeThreadLabelMembership(labels, messageLabels);
  }, [conversation, labelsQuery.data, multiSelectActive, selectedThreads]);
  const activeIds = resolveActiveIds(multiSelectActive, selectedIds, threadId);
  const summary = deriveReaderTriageSummary({
    multiSelectActive: multiSelectActive,
    selectedThreads: selectedThreads,
    conversation: conversation,
  });
  const isSpam = summary.systemLabelIds.includes('SPAM');
  const gmailThreadUrl = buildGmailThreadWebUrl(threadId, accountEmail);
  const moveToCurrentLabelIds = resolveMoveToCurrentLabelIds(multiSelectActive, selectedThreads);
  const isConversationLoading =
    conversationQuery.isPending && threadId !== null && !multiSelectActive;
  return (
    <ReadingPane
      threadId={threadId}
      conversation={conversation}
      loading={isConversationLoading}
      error={conversationQuery.isError}
      onFetchBody={(messageId) => fetchBody.mutate(messageId)}
      loadingMessageId={fetchBody.isPending ? fetchBody.variables : undefined}
      failedMessageId={fetchBody.isError ? fetchBody.variables : undefined}
      onMessageTriage={(messageId, intent) =>
        messageTriage.mutate(threadId ?? '', [messageId], intent)
      }
      onCompose={(action, messageId) => {
        if (!accountId) return;
        void openComposeAction({
          action: action,
          accountId: accountId,
          accountEmail: accountEmail,
          subject: conversation?.subject ?? '',
          message: conversation?.messages.find((entry) => entry.id === messageId),
        });
      }}
      onComposeTo={(participant) => {
        if (accountId) openNewMessage(accountId, accountEmail, participant);
      }}
      onLoadImages={allowImagesFor}
      onTrustSender={trustImageSender}
      gmailThreadUrl={gmailThreadUrl}
      accountId={accountId}
      systemLabelIds={summary.systemLabelIds}
      moveToCurrentLabelIds={moveToCurrentLabelIds}
      labelMenuEntries={labelMenuEntries}
      selectedCount={selectedIds.size}
      selectedThreads={selectedRows}
      loadedThreadCount={loadedThreads.length}
      onClearSelection={clearSelection}
      onSelectAll={() => selectAll(loadedThreads.map((thread) => thread.id))}
      unread={summary.unread}
      starred={summary.starred}
      triageHandlers={triageHandlersFor(
        activeIds,
        summary.unread,
        summary.starred,
        isSpam,
        triage.mutate,
      )}
    />
  );
}
