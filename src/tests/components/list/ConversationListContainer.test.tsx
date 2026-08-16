import { act, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ConversationListContainer } from '@/components/list/ConversationList';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';

function renderWithClient() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ConversationListContainer />
    </QueryClientProvider>,
  );
}

const threadA = {
  id: 'thread-a',
  subject: 'First page',
  sender: { display: 'A', address: 'a@example.com' },
  sentRecipient: null,
  latestAt: Date.parse('2026-08-11T10:00:00Z'),
  messageCount: 1,
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
  hasDraft: false,
};
const threadB = {
  id: 'thread-b',
  subject: 'Second page',
  sender: { display: 'B', address: 'b@example.com' },
  sentRecipient: null,
  latestAt: Date.parse('2026-08-01T10:00:00Z'),
  messageCount: 1,
  isUnread: false,
  isStarred: false,
  hasAttachments: false,
  hasDraft: false,
};

describe('ConversationListContainer', () => {
  it('fetches the next page of real conversations from list_threads when scrolling to the bottom', async () => {
    useLayoutStore.setState({ density: 'comfortable', layout: 'three-column' });
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: null,
      keyboardCursor: null,
    });
    ipc.override('list_threads', ({ cursor }) =>
      cursor
        ? { items: [threadB], nextCursor: null }
        : {
            items: [threadA],
            nextCursor: { latestAt: threadA.latestAt, id: threadA.id },
          },
    );

    renderWithClient();

    expect(await screen.findByText('First page')).toBeInTheDocument();
    expect(screen.queryByText('Second page')).not.toBeInTheDocument();

    const list = screen.getByTestId('conversation-list');
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
    });
    await act(async () => {
      list.dispatchEvent(new Event('scroll'));
    });

    expect(await screen.findByText('Second page')).toBeInTheDocument();
  });
});
