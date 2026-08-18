import { useMemo } from 'react';
import { ActionRibbon, type ActionRibbonProps } from '@/components/actions/ActionRibbon';
import { BulkSelectionPanel } from '@/components/actions/BulkSelectionPanel';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { LoadingState } from '@/components/states/LoadingState';
import { openEditDraft, openForward, openNewMessage, openReply } from '@/lib/compose/entry';
import {
  useAccountsQuery,
  useConversationQuery,
  useFetchMessageBodyMutation,
  useLabelsQuery,
  useMessageTriageIntentMutation,
  useSearchThreadsQuery,
  useThreadTriageIntentMutation,
  useThreadsQuery,
  type MessageTriageIntent,
  type ThreadTriageIntent,
} from '@/lib/query/hooks';
import { messageBadges } from '@/lib/labels/badges';
import { computeThreadLabelMembership, mapConversation } from '@/lib/query/mappers';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import type { MoveDestinationId } from '@/components/actions/MoveToMenu';
import { MessageCard, type MessageRibbonProps, type ReaderMessage } from './MessageCard';

const MOVE_DESTINATION_IDS: MoveDestinationId[] = ['INBOX', 'SPAM', 'TRASH'];

function intersectMessageLabelIds(messagesLabelIds: string[][]): string[] {
  if (messagesLabelIds.length === 0) return [];
  const [first, ...rest] = messagesLabelIds;
  return first.filter((id) => rest.every((labelIds) => labelIds.includes(id)));
}

function intersectThreadSystemLabelIds(threads: { systemLabelIds?: string[] }[]): string[] {
  if (threads.length === 0) return [];
  const [first, ...rest] = threads;
  return (first.systemLabelIds ?? []).filter((id) =>
    rest.every((thread) => (thread.systemLabelIds ?? []).includes(id)),
  );
}

export type ReaderConversation = { id: string; subject: string; messages: ReaderMessage[] };
type TriageHandlers = Pick<
  ActionRibbonProps,
  'onToggleRead' | 'onToggleStar' | 'onApplyLabels' | 'onMoveTo' | 'onToggleSpam' | 'onDelete'
>;
export type ComposeAction = 'reply' | 'reply-all' | 'forward' | 'edit-draft';

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
        sentAt: new Date('2026-08-10T09:00:00Z'),
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
        sentAt: new Date('2026-08-11T09:00:00Z'),
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

export function ReadingPane({
  threadId,
  conversation = threadId ? readerFixtures[threadId] : undefined,
  loading = false,
  error = false,
  systemLabelIds,
  moveToCurrentLabelIds,
  labelMenuEntries = [],
  selectedCount = 0,
  unread = false,
  starred = false,
  triageHandlers,
  onFetchBody,
  loadingMessageId,
  failedMessageId,
  onMessageTriage,
  onCompose,
  onComposeTo,
  onLoadImages,
  onTrustSender,
}: {
  threadId: string | null;
  conversation?: ReaderConversation;
  loading?: boolean;
  error?: boolean;
  systemLabelIds?: string[];
  moveToCurrentLabelIds?: string[];
  labelMenuEntries?: MessageRibbonProps['labels'];
  selectedCount?: number;
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
}) {
  const fixtureState = window.__LATENTMAIL_PLAYWRIGHT_IPC__
    ? window.__LATENTMAIL_PLAYWRIGHT_READER_STATE__
    : undefined;
  if (selectedCount > 0) {
    return (
      <BulkSelectionPanel
        count={selectedCount}
        systemLabelIds={systemLabelIds ?? []}
        moveToCurrentLabelIds={moveToCurrentLabelIds}
        unread={unread}
        starred={starred}
        labels={labelMenuEntries}
        {...(triageHandlers ?? noTriageHandlers)}
      />
    );
  }
  if (!threadId) return <EmptyState>Select a conversation to read it.</EmptyState>;
  if (loading || fixtureState === 'loading')
    return <LoadingState>Loading conversation…</LoadingState>;
  if (error || fixtureState === 'error')
    return <ErrorState>Could not load this conversation.</ErrorState>;
  if (!conversation) return <EmptyState>Conversation unavailable.</EmptyState>;
  const threadUnread = conversation.messages.some((message) => message.unread);
  const threadStarred = conversation.messages.some((message) => message.starred);
  const threadSystemLabelIds =
    systemLabelIds ??
    intersectMessageLabelIds(conversation.messages.map((message) => message.labelIds ?? []));
  const threadHandlers = triageHandlers ?? noTriageHandlers;
  const lastMessage = conversation.messages.at(-1);
  const composeThread = (action: ComposeAction) => {
    if (lastMessage) onCompose?.(action, lastMessage.id);
  };
  const messageRibbonBase: MessageRibbonProps = {
    systemLabelIds: [],
    labels: labelMenuEntries,
    ...threadHandlers,
    onReply: () => undefined,
    onReplyAll: () => undefined,
    onForward: () => undefined,
  };
  return (
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
            systemLabelIds={threadSystemLabelIds}
            unread={threadUnread}
            starred={threadStarred}
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
            ribbon={{
              ...messageRibbonBase,
              systemLabelIds: message.labelIds ?? [],
              onApplyLabels: (changes) => onMessageTriage?.(message.id, { kind: 'label', ...changes }),
              onMoveTo: (destination) => onMessageTriage?.(message.id, { kind: 'move', destination }),
              onToggleSpam: () =>
                onMessageTriage?.(message.id, {
                  kind: 'move',
                  destination: (message.labelIds ?? []).includes('SPAM') ? 'INBOX' : 'SPAM',
                }),
              onDelete: () => onMessageTriage?.(message.id, { kind: 'delete' }),
              onReply: () => onCompose?.('reply', message.id),
              onReplyAll: () => onCompose?.('reply-all', message.id),
              onForward: () => onCompose?.('forward', message.id),
              onEditDraft: message.isDraft
                ? () => onCompose?.('edit-draft', message.id)
                : undefined,
            }}
            onFetchBody={onFetchBody}
            onComposeTo={onComposeTo}
            onLoadImages={onLoadImages}
            onTrustSender={onTrustSender}
            loadingBody={loadingMessageId === message.id}
            bodyError={failedMessageId === message.id}
          />
        ))}
      </div>
    </section>
  );
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
    onToggleRead: () =>
      mutate(threadIds, { kind: 'label', add: unread ? [] : ['UNREAD'], remove: unread ? ['UNREAD'] : [] }),
    onToggleStar: () =>
      mutate(threadIds, {
        kind: 'label',
        add: starred ? [] : ['STARRED'],
        remove: starred ? ['STARRED'] : [],
      }),
    onApplyLabels: ({ add, remove }: { add: string[]; remove: string[] }) =>
      mutate(threadIds, { kind: 'label', add, remove }),
    onMoveTo: (destination: 'INBOX' | 'SPAM' | 'TRASH') => mutate(threadIds, { kind: 'move', destination }),
    onToggleSpam: () => mutate(threadIds, { kind: 'move', destination: isSpam ? 'INBOX' : 'SPAM' }),
    onDelete: () => mutate(threadIds, { kind: 'delete' }),
  };
}

export function ReadingPaneContainer({ threadId }: { threadId: string | null }) {
  const accountId = useSelectionStore((value) => value.activeAccountId);
  const mailboxId = useSelectionStore((value) => value.activeMailboxId) ?? 'INBOX';
  const allowImagesFor = useSelectionStore((value) => value.allowImagesFor);
  const trustImageSender = useLayoutStore((value) => value.trustImageSender);
  const searchActive = useSearchStore((value) => value.active);
  const searchQuery = useSearchStore((value) => value.submittedQuery);
  const searchScope = useSearchStore((value) => value.scope);
  const accountsQuery = useAccountsQuery();
  const accountEmail = accountsQuery.data?.find((account) => account.id === accountId)?.email ?? '';
  const selectedCount = useMultiSelectStore((value) => value.selectedIds.size);
  const selectedIds = useMultiSelectStore((value) => value.selectedIds);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);
  const conversationQuery = useConversationQuery(accountId, multiSelectActive ? null : threadId);
  const fetchBody = useFetchMessageBodyMutation(accountId, threadId);
  const triage = useThreadTriageIntentMutation(accountId);
  const messageTriage = useMessageTriageIntentMutation(accountId);
  const labelsQuery = useLabelsQuery(accountId);
  const threadsQuery = useThreadsQuery(accountId, mailboxId);
  const searchResultsQuery = useSearchThreadsQuery(accountId, searchQuery, searchScope);
  const activeThreadsQuery = searchActive ? searchResultsQuery : threadsQuery;
  const conversation = conversationQuery.data ? mapConversation(conversationQuery.data) : undefined;
  const loadedThreads = useMemo(
    () => (activeThreadsQuery.data?.pages ?? []).flatMap((page) => page.items),
    [activeThreadsQuery.data],
  );
  const selectedThreads = useMemo(
    () => loadedThreads.filter((thread) => selectedIds.has(thread.id)),
    [selectedIds, loadedThreads],
  );
  const labelMenuEntries = useMemo(
    () =>
      multiSelectActive
        ? (labelsQuery.data ?? [])
            .filter((label) => label.kind === 'user')
            .map((label) => ({
              id: label.id,
              name: label.name,
              color: 'black',
              membership:
                selectedThreads.length === 0
                  ? ('unchecked' as const)
                  : selectedThreads.every((thread) => thread.labelIndicators?.includes(label.name))
                    ? ('checked' as const)
                    : selectedThreads.some((thread) => thread.labelIndicators?.includes(label.name))
                      ? ('indeterminate' as const)
                      : ('unchecked' as const),
            }))
        : computeThreadLabelMembership(
            labelsQuery.data ?? [],
            conversation?.messages.map((message) => message.labelIds ?? []) ?? [],
          ),
    [conversation, labelsQuery.data, multiSelectActive, selectedThreads],
  );
  const activeIds = multiSelectActive ? [...selectedIds] : threadId ? [threadId] : [];
  const unread = multiSelectActive
    ? selectedThreads.some((thread) => thread.isUnread)
    : (conversation?.messages.some((message) => message.unread) ?? false);
  const starred = multiSelectActive
    ? selectedThreads.some((thread) => thread.isStarred)
    : (conversation?.messages.some((message) => message.starred) ?? false);
  const threadSystemLabelIds = intersectMessageLabelIds(
    conversation?.messages.map((message) => message.labelIds ?? []) ?? [],
  );
  const systemLabelIds = multiSelectActive
    ? intersectThreadSystemLabelIds(selectedThreads)
    : threadSystemLabelIds;
  const isSpam = systemLabelIds.includes('SPAM');
  const moveToCurrentLabelIds = multiSelectActive
    ? MOVE_DESTINATION_IDS.filter(
        (id) =>
          selectedThreads.length > 0 &&
          selectedThreads.every((thread) => (thread.systemLabelIds ?? []).includes(id)),
      )
    : undefined;
  return (
    <ReadingPane
      threadId={threadId}
      conversation={conversation}
      loading={conversationQuery.isPending && threadId !== null && !multiSelectActive}
      error={conversationQuery.isError}
      onFetchBody={(messageId) => fetchBody.mutate(messageId)}
      loadingMessageId={fetchBody.isPending ? fetchBody.variables : undefined}
      failedMessageId={fetchBody.isError ? fetchBody.variables : undefined}
      onMessageTriage={(messageId, intent) =>
        messageTriage.mutate(threadId ?? '', [messageId], intent)
      }
      onCompose={(action, messageId) => {
        if (!accountId) return;
        const message = conversation?.messages.find((entry) => entry.id === messageId);
        if (action === 'reply') void openReply('reply', accountId, accountEmail, message);
        else if (action === 'reply-all')
          void openReply('reply-all', accountId, accountEmail, message);
        else if (action === 'forward') void openForward(accountId, accountEmail, message);
        else openEditDraft(accountId, accountEmail, conversation?.subject ?? '', message);
      }}
      onComposeTo={(participant) => {
        if (accountId) openNewMessage(accountId, accountEmail, participant);
      }}
      onLoadImages={allowImagesFor}
      onTrustSender={trustImageSender}
      systemLabelIds={systemLabelIds}
      moveToCurrentLabelIds={moveToCurrentLabelIds}
      labelMenuEntries={labelMenuEntries}
      selectedCount={selectedCount}
      unread={unread}
      starred={starred}
      triageHandlers={triageHandlersFor(activeIds, unread, starred, isSpam, triage.mutate)}
    />
  );
}
