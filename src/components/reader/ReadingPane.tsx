import { useMemo } from 'react';
import { ActionRibbon } from '@/components/actions/ActionRibbon';
import { BulkSelectionPanel } from '@/components/actions/BulkSelectionPanel';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { LoadingState } from '@/components/states/LoadingState';
import { openComposeAction, openNewMessage, type ComposeAction } from '@/lib/compose/entry';
import { buildGmailThreadWebUrl } from '@/lib/gmail/thread-url';
import { messageBadges } from '@/lib/labels/badges';
import {
  useAccountsQuery,
  useConversationQuery,
  useFetchMessageBodyMutation,
  useLabelsQuery,
  useSearchThreadsQuery,
  useThreadsQuery,
} from '@/lib/query/hooks';
import { computeThreadLabelMembership, mapConversation, mapThreadToRow } from '@/lib/query/mappers';
import {
  useMessageTriageIntentMutation,
  useThreadTriageIntentMutation,
} from '@/lib/query/mutations';
import type { Conversation } from '@/lib/types/conversation';
import { useLayoutStore } from '@/stores/layout';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';
import { MessageCard, type MessageRibbonProps } from './MessageCard';
import { ReaderContextMenu } from './ReaderContextMenu';
import { readerFixtures } from './reading-pane-fixtures';
import {
  buildBulkLabelMenuEntries,
  buildMessageRibbon,
  DEFAULT_TRIAGE_CONTEXT,
  defaultMessageRibbonBase,
  deriveReaderTriageSummary,
  noTriageHandlers,
  resolveActiveIds,
  resolveMoveToCurrentLabelIds,
  resolveThreadSystemLabelIds,
  triageHandlersFor,
  type ReaderConversation,
  type ReadingPaneBodyContext,
  type ReadingPaneBulkSelection,
  type ReadingPaneComposeContext,
  type ReadingPaneProps,
  type ReadingPaneTriageContext,
} from './reading-pane-helpers';

export { readerFixtures };
export type {
  ComposeAction,
  ReaderConversation,
  ReadingPaneBodyContext,
  ReadingPaneBulkSelection,
  ReadingPaneComposeContext,
  ReadingPaneProps,
  ReadingPaneTriageContext,
};

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

function resolveConversation(
  provided: ReaderConversation | undefined,
  threadId: string | null,
): ReaderConversation | undefined {
  if (provided !== undefined) return provided;
  return threadId ? readerFixtures[threadId] : undefined;
}

function renderBulkSelection(
  bulkSelection: ReadingPaneBulkSelection,
  triage: ReadingPaneTriageContext = DEFAULT_TRIAGE_CONTEXT,
) {
  return (
    <BulkSelectionPanel
      count={bulkSelection.count}
      selectedThreads={bulkSelection.selectedThreads}
      loadedThreadCount={bulkSelection.loadedThreadCount}
      onClearSelection={bulkSelection.onClearSelection}
      onSelectAll={bulkSelection.onSelectAll}
      systemLabelIds={triage.systemLabelIds}
      moveToCurrentLabelIds={bulkSelection.moveToCurrentLabelIds}
      unread={triage.unread}
      starred={triage.starred}
      labels={triage.labelMenuEntries}
      {...triage.handlers}
    />
  );
}

function ConversationMessageList({
  conversation,
  props,
  messageRibbonBase,
  labelMenuEntries,
}: {
  conversation: ReaderConversation;
  props: ReadingPaneProps;
  messageRibbonBase: MessageRibbonProps;
  labelMenuEntries: MessageRibbonProps['labels'];
}) {
  const body = props.body;
  const accountId = props.accountId ?? null;
  const gmailThreadUrl = props.gmailThreadUrl ?? null;
  return conversation.messages.map((message, index) => {
    const isLatest = index === conversation.messages.length - 1;
    return (
      <MessageCard
        key={message.id}
        message={message}
        expanded={isLatest}
        newest={isLatest}
        badges={messageBadges(message, labelMenuEntries)}
        ribbon={buildMessageRibbon({
          base: messageRibbonBase,
          message: message,
          accountId: accountId,
          subject: conversation.subject,
          onMessageTriage: props.triage?.onMessageTriage,
          onCompose: props.compose?.onCompose,
        })}
        onFetchBody={body?.onFetchBody}
        onComposeTo={props.compose?.onComposeTo}
        onLoadImages={body?.onLoadImages}
        onTrustSender={body?.onTrustSender}
        loadingBody={body?.loadingMessageId === message.id}
        bodyError={body?.failedMessageId === message.id}
        gmailThreadUrl={gmailThreadUrl}
        accountId={accountId}
      />
    );
  });
}

function ConversationView({
  conversation,
  props,
}: {
  conversation: ReaderConversation;
  props: ReadingPaneProps;
}) {
  const labelMenuEntries = props.triage?.labelMenuEntries ?? [];
  const threadHandlers = props.triage?.handlers ?? noTriageHandlers;
  const lastMessage = conversation.messages.at(-1);
  const composeThread = (action: ComposeAction) => {
    if (lastMessage) props.compose?.onCompose?.(action, lastMessage.id);
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
              systemLabelIds={resolveThreadSystemLabelIds(
                props.triage?.systemLabelIds,
                conversation,
              )}
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
          <ConversationMessageList
            conversation={conversation}
            props={props}
            messageRibbonBase={messageRibbonBase}
            labelMenuEntries={labelMenuEntries}
          />
        </div>
      </section>
    </ReaderContextMenu>
  );
}

export function ReadingPane(props: ReadingPaneProps) {
  if (props.bulkSelection && props.bulkSelection.count > 0) {
    return renderBulkSelection(props.bulkSelection, props.triage);
  }
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

function useReadingPaneQueries(accountId: string | null, threadId: string | null) {
  const mailboxId = useSelectionStore((selection) => selection.activeMailboxId) ?? 'INBOX';
  const selectedIds = useMultiSelectStore((multiSelect) => multiSelect.selectedIds);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);
  const conversationQuery = useConversationQuery(accountId, multiSelectActive ? null : threadId);
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
  const summary = deriveReaderTriageSummary({
    multiSelectActive: multiSelectActive,
    selectedThreads: selectedThreads,
    conversation: conversation,
  });
  return {
    selectedIds: selectedIds,
    multiSelectActive: multiSelectActive,
    conversationQuery: conversationQuery,
    loadedThreads: loadedThreads,
    conversation: conversation,
    selectedThreads: selectedThreads,
    selectedRows: selectedRows,
    labelMenuEntries: labelMenuEntries,
    summary: summary,
  };
}

function buildComposeContext(
  accountId: string | null,
  accountEmail: string,
  conversation: ReaderConversation | undefined,
): ReadingPaneComposeContext {
  return {
    onCompose: (action, messageId) => {
      if (!accountId) return;
      void openComposeAction({
        action: action,
        accountId: accountId,
        accountEmail: accountEmail,
        subject: conversation?.subject ?? '',
        message: conversation?.messages.find((entry) => entry.id === messageId),
      });
    },
    onComposeTo: (participant) => {
      if (accountId) openNewMessage(accountId, accountEmail, participant);
    },
  };
}

function useReadingPaneContexts(
  accountId: string | null,
  threadId: string | null,
  data: ReturnType<typeof useReadingPaneQueries>,
) {
  const allowImagesFor = useSelectionStore((selection) => selection.allowImagesFor);
  const trustImageSender = useLayoutStore((layout) => layout.trustImageSender);
  const accountEmail = useReaderAccountEmail(accountId);
  const clearSelection = useMultiSelectStore((multiSelect) => multiSelect.clear);
  const selectAll = useMultiSelectStore((multiSelect) => multiSelect.selectAll);
  const fetchBody = useFetchMessageBodyMutation(accountId);
  const triage = useThreadTriageIntentMutation(accountId);
  const messageTriage = useMessageTriageIntentMutation(accountId);
  const activeIds = resolveActiveIds(data.multiSelectActive, data.selectedIds, threadId);

  return {
    gmailThreadUrl: buildGmailThreadWebUrl(threadId, accountEmail),
    bulkSelection: {
      count: data.selectedIds.size,
      selectedThreads: data.selectedRows,
      loadedThreadCount: data.loadedThreads.length,
      moveToCurrentLabelIds: resolveMoveToCurrentLabelIds(
        data.multiSelectActive,
        data.selectedThreads,
      ),
      onClearSelection: clearSelection,
      onSelectAll: () => selectAll(data.loadedThreads.map((thread) => thread.id)),
    },
    triage: {
      systemLabelIds: data.summary.systemLabelIds,
      labelMenuEntries: data.labelMenuEntries,
      unread: data.summary.unread,
      starred: data.summary.starred,
      handlers: triageHandlersFor({
        threadIds: activeIds,
        unread: data.summary.unread,
        starred: data.summary.starred,
        isSpam: data.summary.systemLabelIds.includes('SPAM'),
        mutate: triage.mutate,
      }),
      onMessageTriage: (messageId: string, intent: Parameters<typeof messageTriage.mutate>[2]) =>
        messageTriage.mutate(threadId ?? '', [messageId], intent),
    },
    body: {
      onFetchBody: (messageId: string) => fetchBody.mutate(messageId),
      loadingMessageId: fetchBody.isPending ? fetchBody.variables : undefined,
      failedMessageId: fetchBody.isError ? fetchBody.variables : undefined,
      onLoadImages: allowImagesFor,
      onTrustSender: trustImageSender,
    },
    compose: buildComposeContext(accountId, accountEmail, data.conversation),
  };
}

export function ReadingPaneContainer({ threadId }: { threadId: string | null }) {
  const accountId = useSelectionStore((selection) => selection.activeAccountId);
  const data = useReadingPaneQueries(accountId, threadId);
  const contexts = useReadingPaneContexts(accountId, threadId, data);
  const isConversationLoading =
    data.conversationQuery.isPending && threadId !== null && !data.multiSelectActive;

  return (
    <ReadingPane
      threadId={threadId}
      conversation={data.conversation}
      loading={isConversationLoading}
      error={data.conversationQuery.isError}
      accountId={accountId}
      gmailThreadUrl={contexts.gmailThreadUrl}
      bulkSelection={contexts.bulkSelection}
      triage={contexts.triage}
      body={contexts.body}
      compose={contexts.compose}
    />
  );
}
