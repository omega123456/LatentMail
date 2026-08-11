import { useMemo } from 'react';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { LoadingState } from '@/components/states/LoadingState';
import { useConversationQuery, useLabelsQuery } from '@/lib/query/hooks';
import { mapConversation } from '@/lib/query/mappers';
import { useSelectionStore } from '@/stores/selection';
import { MessageCard, type ReaderMessage } from './MessageCard';

export type ReaderConversation = { id: string; subject: string; messages: ReaderMessage[] };

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
}: {
  threadId: string | null;
  conversation?: ReaderConversation;
  loading?: boolean;
  error?: boolean;
}) {
  const fixtureState = window.__LATENTMAIL_PLAYWRIGHT_IPC__
    ? window.__LATENTMAIL_PLAYWRIGHT_READER_STATE__
    : undefined;
  if (!threadId) return <EmptyState>Select a conversation to read it.</EmptyState>;
  if (loading || fixtureState === 'loading')
    return <LoadingState>Loading conversation…</LoadingState>;
  if (error || fixtureState === 'error')
    return <ErrorState>Could not load this conversation.</ErrorState>;
  if (!conversation) return <EmptyState>Conversation unavailable.</EmptyState>;
  return (
    <section
      aria-label="Reading pane"
      className="h-full overflow-auto bg-surface-bright p-stack-gap-md dark:bg-dark-surface-container-high"
      data-testid="reading-pane"
    >
      <div className="mx-auto min-h-full max-w-4xl rounded-md border border-outline-variant/20 bg-surface-container-lowest p-8 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest">
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
        {conversation.messages.map((message, index) => (
          <MessageCard
            key={message.id}
            message={message}
            expanded={index === conversation.messages.length - 1}
            newest={index === conversation.messages.length - 1}
          />
        ))}
      </div>
    </section>
  );
}

/** Composition-root wiring: fetches the selected thread's conversation via
 * `useConversationQuery` (already Rust-sanitized, D12's dual-layer sanitize
 * pass happens in `BodyFrame`) and hands it to the presentational
 * `ReadingPane` above. */
export function ReadingPaneContainer({ threadId }: { threadId: string | null }) {
  const accountId = useSelectionStore((value) => value.activeAccountId);
  const conversationQuery = useConversationQuery(accountId, threadId);
  const labelsQuery = useLabelsQuery(accountId);
  const labelNamesById = useMemo(
    () => new Map((labelsQuery.data ?? []).map((label) => [label.id, label.name])),
    [labelsQuery.data],
  );
  const conversation = conversationQuery.data
    ? mapConversation(conversationQuery.data, labelNamesById)
    : undefined;
  return (
    <ReadingPane
      threadId={threadId}
      conversation={conversation}
      loading={conversationQuery.isPending && threadId !== null}
      error={conversationQuery.isError}
    />
  );
}
