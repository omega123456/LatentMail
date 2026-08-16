import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationListContainer } from '@/components/list/ConversationList';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';
import { useToastStore } from '@/stores/toast';
import { queryKeys } from '@/lib/query/keys';

const thread = {
  id: 'thread-1',
  subject: 'Mutation',
  sender: { display: 'A', address: 'a@example.com' },
  sentRecipient: null,
  latestAt: 0,
  messageCount: 1,
  isUnread: true,
  isStarred: false,
  hasAttachments: false,
  hasDraft: false,
};

beforeEach(() => {
  useSelectionStore.setState({ activeAccountId: 'account', activeMailboxId: 'INBOX' });
  useToastStore.setState({ toasts: [] });
  ipc.override('list_threads', { items: [thread], nextCursor: null });
});

function renderList() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ConversationListContainer />
    </QueryClientProvider>,
  );
}

describe('thread mutations', () => {
  it('optimistically stars a conversation', async () => {
    const user = userEvent.setup();
    let resolve!: () => void;
    ipc.override(
      'mutate_threads',
      () =>
        new Promise((done) => {
          resolve = () => done([]);
        }),
    );
    renderList();
    await user.click(await screen.findByLabelText('Star Mutation'));
    expect(screen.getByLabelText('Unstar Mutation')).toBeInTheDocument();
    await act(async () => {
      resolve();
    });
  });

  it('rolls a failed star back and shows an error toast', async () => {
    const user = userEvent.setup();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipc.override('mutate_threads', () => Promise.reject(new Error('offline')));
    renderList();
    await user.click(await screen.findByLabelText('Star Mutation'));
    await waitFor(() => expect(screen.getByLabelText('Star Mutation')).toBeInTheDocument());
    expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/couldn’t update/i);
    expect(error).toHaveBeenCalledWith('ipc mutate_threads failed: offline');
    error.mockRestore();
  });

  it('invalidates every open conversation for the account once a thread-level triage settles', async () => {
    const user = userEvent.setup();
    ipc.override('mutate_threads', []);
    ipc.override('load_conversation', {
      threadId: 'thread-9',
      subject: 'A different open conversation',
      messages: [],
    });
    const client = new QueryClient();
    // Seed a real conversation query for a *different* thread than the one
    // being triaged — this is exactly the case the old `('account', '')` key
    // could never match, since it isn't a prefix of `('account', 'thread-9')`.
    await client.fetchQuery({
      queryKey: queryKeys.conversation('account', 'thread-9'),
      queryFn: () =>
        ipc.tauriInvoke('load_conversation', { accountId: 'account', threadId: 'thread-9' }),
    });
    render(
      <QueryClientProvider client={client}>
        <ConversationListContainer />
      </QueryClientProvider>,
    );
    await user.click(await screen.findByLabelText('Star Mutation'));
    await waitFor(() =>
      expect(
        client.getQueryState(queryKeys.conversation('account', 'thread-9'))?.isInvalidated,
      ).toBe(true),
    );
  });
});
