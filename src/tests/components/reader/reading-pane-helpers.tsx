import { getTime, parseISO } from 'date-fns';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { EventBridge } from '@/lib/query/event-bridge';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';

export function renderWithClient({ bridged }: { bridged: boolean } = { bridged: false }) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      {bridged && <EventBridge />}
      <ReadingPaneContainer threadId="thread-1" />
    </QueryClientProvider>,
  );
}

export function conversationFor(htmlPresence: 'neverFetched' | 'present' | 'tooLarge') {
  return {
    threadId: 'thread-1',
    subject: 'Subject',
    messages: [
      {
        id: 'message-1',
        sender: 'Alex <alex@example.com>',
        recipients: ['me@example.com'],
        subject: 'Subject',
        sentAt: getTime(parseISO('2026-08-10T09:00:00Z')),
        snippet: 'Preview',
        htmlBody: null,
        htmlPresence: htmlPresence,
        truncated: false,
        plainBody: null,
        hasAttachments: false,
        isUnread: false,
        isStarred: false,
        labelIds: ['INBOX'],
        remoteImagesBlocked: false,
        remoteImagesAllowed: false,
        inlineImagesPending: false,
        attachments: [],
      },
    ],
  };
}

export function selectAccount() {
  act(() =>
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: 'thread-1',
      keyboardCursor: null,
    }),
  );
}

export function resetReadingPaneSearchStore() {
  act(() =>
    useSearchStore.setState({
      draft: '',
      submittedQuery: '',
      scope: { kind: 'default' },
      active: false,
      panelOpen: false,
    }),
  );
}
