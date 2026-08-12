import { useMemo } from 'react';
import { ActionRibbon, type ActionRibbonProps } from '@/components/actions/ActionRibbon';
import { BulkSelectionPanel } from '@/components/actions/BulkSelectionPanel';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { LoadingState } from '@/components/states/LoadingState';
import { useConversationQuery, useFetchMessageBodyMutation, useLabelsQuery, useMessageTriageMutation, useThreadsQuery, useTriageMutation } from '@/lib/query/hooks';
import { computeThreadLabelMembership, mapConversation } from '@/lib/query/mappers';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { MessageCard, type MessageRibbonProps, type ReaderMessage } from './MessageCard';
import { moveSource } from '@/components/actions/MoveToMenu';

export type ReaderConversation = { id: string; subject: string; messages: ReaderMessage[] };
type TriageHandlers = Pick<ActionRibbonProps, 'onToggleRead' | 'onToggleStar' | 'onApplyLabels' | 'onMoveTo' | 'onToggleSpam' | 'onDelete'>;

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
        labels: ['Marketing', 'Important'],
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
  mailboxId = 'INBOX',
  currentLabelName,
  labelMenuEntries = [],
  selectedCount = 0,
  unread = false,
  starred = false,
  triageHandlers,
  onFetchBody,
  loadingMessageId,
  failedMessageId,
  onMessageTriage,
}: {
  threadId: string | null;
  conversation?: ReaderConversation;
  loading?: boolean;
  error?: boolean;
  mailboxId?: string;
  currentLabelName?: string;
  labelMenuEntries?: MessageRibbonProps['labels'];
  /** >0 substitutes `BulkSelectionPanel` for the normal reading pane
   * content, per the wireframe's "Multi-selection and bulk panel". */
  selectedCount?: number;
  unread?: boolean;
  starred?: boolean;
  triageHandlers?: TriageHandlers;
  onFetchBody?: (messageId: string) => void;
  loadingMessageId?: string;
  failedMessageId?: string;
  onMessageTriage?: (messageId: string, change: { add: string[]; remove: string[] }) => void;
}) {
  const fixtureState = window.__LATENTMAIL_PLAYWRIGHT_IPC__
    ? window.__LATENTMAIL_PLAYWRIGHT_READER_STATE__
    : undefined;
  if (selectedCount > 0) {
    return (
      <BulkSelectionPanel
        count={selectedCount}
        mailboxId={mailboxId}
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
  const threadHandlers = triageHandlers ?? noTriageHandlers;
  const messageRibbonBase: MessageRibbonProps = {
    mailboxId,
    labels: labelMenuEntries,
    currentLabelName,
    ...threadHandlers,
  };
  return (
    <section
      aria-label="Reading pane"
      className="h-full overflow-auto bg-surface-bright p-stack-gap-md dark:bg-dark-surface-container-high"
      data-testid="reading-pane"
    >
      <div className="min-h-full w-full rounded-md border border-outline-variant/20 bg-surface-container-lowest p-8 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest">
        <div className="mb-container-padding flex items-start justify-between gap-4">
          <h1 className="text-display-sm leading-tight text-on-surface dark:text-dark-on-surface">
            {conversation.subject}
          </h1>
          <div className="flex shrink-0 gap-2">
            {(conversation.messages.at(-1)?.labels ?? []).map((label, index) => (
              <span
                key={label}
                className={`rounded-full px-3 py-1 text-label-sm ${index === 0 ? 'bg-secondary-container text-on-secondary-container dark:bg-dark-secondary-container dark:text-dark-on-secondary-container' : 'bg-tertiary-container text-on-tertiary-container dark:bg-dark-tertiary-container dark:text-dark-on-tertiary-container'}`}
              >
                {label}
              </span>
            ))}
          </div>
        </div>
        <div className="mb-container-padding">
          <ActionRibbon
            mailboxId={mailboxId}
            unread={threadUnread}
            starred={threadStarred}
            labels={labelMenuEntries}
            currentLabelName={currentLabelName}
            {...threadHandlers}
          />
        </div>
        {conversation.messages.map((message, index) => (
          <MessageCard
            key={message.id}
            message={message}
            expanded={index === conversation.messages.length - 1}
            newest={index === conversation.messages.length - 1}
            ribbon={{
              ...messageRibbonBase,
              onApplyLabels: (changes) => onMessageTriage?.(message.id, changes),
              onMoveTo: (destination) => onMessageTriage?.(message.id, { add: [destination], remove: moveSource(mailboxId, currentLabelName) }),
              onToggleSpam: () => onMessageTriage?.(message.id, { add: mailboxId === 'SPAM' ? [] : ['SPAM'], remove: mailboxId === 'SPAM' ? ['SPAM'] : [] }),
              onDelete: () => onMessageTriage?.(message.id, { add: ['TRASH'], remove: [] }),
            }}
            onFetchBody={onFetchBody}
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
  mailboxId: string,
  mutate: ReturnType<typeof useTriageMutation>['mutate'],
  currentLabelName?: string,
) {
  return {
    onToggleRead: () => mutate({ threadIds, add: unread ? [] : ['UNREAD'], remove: unread ? ['UNREAD'] : [] }),
    onToggleStar: () => mutate({ threadIds, add: starred ? [] : ['STARRED'], remove: starred ? ['STARRED'] : [] }),
    onApplyLabels: ({ add, remove }: { add: string[]; remove: string[] }) => mutate({ threadIds, add, remove }),
    onMoveTo: (destination: string) => mutate({ threadIds, add: [destination], remove: moveSource(mailboxId, currentLabelName) }),
    onToggleSpam: () => mutate({ threadIds, add: mailboxId === 'SPAM' ? [] : ['SPAM'], remove: mailboxId === 'SPAM' ? ['SPAM'] : [] }),
    onDelete: () => mutate({ threadIds, add: ['TRASH'], remove: [] }),
  };
}

/** Composition-root wiring: fetches the selected thread's conversation via
 * `useConversationQuery` (already Rust-sanitized, D12's dual-layer sanitize
 * pass happens in `BodyFrame`) and hands it to the presentational
 * `ReadingPane` above. */
export function ReadingPaneContainer({ threadId }: { threadId: string | null }) {
  const accountId = useSelectionStore((value) => value.activeAccountId);
  const mailboxId = useSelectionStore((value) => value.activeMailboxId) ?? 'INBOX';
  const selectedCount = useMultiSelectStore((value) => value.selectedIds.size);
  const selectedIds = useMultiSelectStore((value) => value.selectedIds);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);
  const conversationQuery = useConversationQuery(accountId, multiSelectActive ? null : threadId);
  const fetchBody = useFetchMessageBodyMutation(accountId, threadId);
  const triage = useTriageMutation(accountId);
  const messageTriage = useMessageTriageMutation(accountId);
  const labelsQuery = useLabelsQuery(accountId);
  const threadsQuery = useThreadsQuery(accountId, mailboxId);
  const labelNamesById = useMemo(
    () => new Map((labelsQuery.data ?? []).map((label) => [label.id, label.name])),
    [labelsQuery.data],
  );
  const conversation = conversationQuery.data
    ? mapConversation(conversationQuery.data, labelNamesById)
    : undefined;
  const selectedThreads = useMemo(
    () => (threadsQuery.data?.pages ?? []).flatMap((page) => page.items).filter((thread) => selectedIds.has(thread.id)),
    [selectedIds, threadsQuery.data],
  );
  const labelMenuEntries = useMemo(
    () =>
      multiSelectActive
        ? (labelsQuery.data ?? []).filter((label) => label.kind === 'user').map((label) => ({
            id: label.id,
            name: label.name,
            color: 'black',
            membership: selectedThreads.length === 0
              ? 'unchecked' as const
              : selectedThreads.every((thread) => thread.labelIndicators?.includes(label.name))
                ? 'checked' as const
                : selectedThreads.some((thread) => thread.labelIndicators?.includes(label.name))
                  ? 'indeterminate' as const
                  : 'unchecked' as const,
          }))
        : computeThreadLabelMembership(labelsQuery.data ?? [], conversation?.messages.map((message) => message.labelIds ?? []) ?? []),
    [conversation, labelsQuery.data, multiSelectActive, selectedThreads],
  );
  // Only a *user* label counts as "the removed source" (FR "Move to") — a
  // system mailbox's own display name (e.g. browsing Inbox) must never be
  // mistaken for one.
  const currentLabelName = labelsQuery.data?.find(
    (label) => label.id === mailboxId && label.kind === 'user',
  )?.name;
  const activeIds = multiSelectActive ? [...selectedIds] : threadId ? [threadId] : [];
  const unread = multiSelectActive
    ? selectedThreads.some((thread) => thread.isUnread)
    : conversation?.messages.some((message) => message.unread) ?? false;
  const starred = multiSelectActive
    ? selectedThreads.some((thread) => thread.isStarred)
    : conversation?.messages.some((message) => message.starred) ?? false;
  return (
    <ReadingPane
      threadId={threadId}
      conversation={conversation}
      loading={conversationQuery.isPending && threadId !== null && !multiSelectActive}
      error={conversationQuery.isError}
      onFetchBody={(messageId) => fetchBody.mutate(messageId)}
      loadingMessageId={fetchBody.isPending ? fetchBody.variables : undefined}
      failedMessageId={fetchBody.isError ? fetchBody.variables : undefined}
      onMessageTriage={(messageId, change) => messageTriage.mutate({ threadId: threadId ?? '', messageIds: [messageId], ...change })}
      mailboxId={mailboxId}
      currentLabelName={currentLabelName}
      labelMenuEntries={labelMenuEntries}
      selectedCount={selectedCount}
      unread={unread}
      starred={starred}
      triageHandlers={triageHandlersFor(activeIds, unread, starred, mailboxId, triage.mutate, currentLabelName)}
    />
  );
}
