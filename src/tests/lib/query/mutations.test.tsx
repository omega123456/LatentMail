import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { ConversationListContainer } from '@/components/list/ConversationList';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';
import { useToastStore } from '@/stores/toast';
import { queryKeys } from '@/lib/query/keys';
import { EventBridge } from '@/lib/query/event-bridge';
import { useRenameLabelMutation } from '@/lib/query/mutations';
import { captureConsole } from '@/tests/console';

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
      <EventBridge />
      <ConversationListContainer />
    </QueryClientProvider>,
  );
}

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
  const consoleInfo = captureConsole('info');
  const user = userEvent.setup();
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  ipc.override('mutate_threads', () => {
    ipc.emit('mail://changed', { accountId: 'account' });
    return Promise.reject(new Error('offline'));
  });
  renderList();
  await user.click(await screen.findByLabelText('Star Mutation'));
  await waitFor(() => expect(screen.getByLabelText('Star Mutation')).toBeInTheDocument());
  expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/couldn’t update/i);
  expect(error).toHaveBeenCalledWith('ipc mutate_threads failed: offline');
  error.mockRestore();
  expect(consoleInfo).toHaveBeenCalledWith('event mail://changed');
});

function listThreadsCallCount() {
  return ipc.tauriInvoke.mock.calls.filter(([command]) => command === 'list_threads').length;
}

it('rolls a star back when the command is rejected before Rust announces anything', async () => {
  const user = userEvent.setup();
  const error = captureConsole('error');
  ipc.override('mutate_threads', () =>
    Promise.reject(new Error('command mutate_threads not allowed')),
  );
  renderList();
  const starButton = await screen.findByLabelText('Star Mutation');
  const fetchesBeforeRollback = listThreadsCallCount();
  await user.click(starButton);
  await waitFor(() => expect(listThreadsCallCount()).toBeGreaterThan(fetchesBeforeRollback));
  expect(await screen.findByLabelText('Star Mutation')).toBeInTheDocument();
  expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/couldn’t update/i);
  expect(error).toHaveBeenCalledWith(
    'ipc mutate_threads failed: command mutate_threads not allowed',
  );
});

it('re-reads labels when a label command is rejected before Rust announces anything', async () => {
  captureConsole('error');
  ipc.override('rename_label', () => Promise.reject(new Error('forbidden')));
  const client = new QueryClient();
  client.setQueryData(queryKeys.labels('account'), [
    {
      id: 'Label_1',
      name: 'Old name',
      kind: 'user',
      color: null,
      messageCount: 0,
      unreadCount: 0,
    },
  ]);
  const { result } = renderHook(() => useRenameLabelMutation('account'), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
  await act(async () => {
    await result.current
      .mutateAsync({ labelId: 'Label_1', name: 'New name' })
      .catch(() => undefined);
  });
  expect(client.getQueryState(queryKeys.labels('account'))?.isInvalidated).toBe(true);
});

it('invalidates every open conversation for the account once Rust announces the triage', async () => {
  const consoleInfo = captureConsole('info');
  const user = userEvent.setup();
  ipc.override('mutate_threads', () => {
    ipc.emit('mail://changed', { accountId: 'account' });
    return [];
  });
  ipc.override('load_conversation', {
    threadId: 'thread-9',
    subject: 'A different open conversation',
    messages: [],
  });
  const client = new QueryClient();

  await client.fetchQuery({
    queryKey: queryKeys.conversationThread('account', 'thread-9'),
    queryFn: () =>
      ipc.tauriInvoke('load_conversation', { accountId: 'account', threadId: 'thread-9' }),
  });
  render(
    <QueryClientProvider client={client}>
      <EventBridge />
      <ConversationListContainer />
    </QueryClientProvider>,
  );
  await user.click(await screen.findByLabelText('Star Mutation'));
  await waitFor(() =>
    expect(
      client.getQueryState(queryKeys.conversationThread('account', 'thread-9'))?.isInvalidated,
    ).toBe(true),
  );
  expect(consoleInfo).toHaveBeenCalledWith('event mail://changed');
});

it('clears the open conversation when it is deleted', async () => {
  const user = userEvent.setup();
  renderList();
  await user.click(await screen.findByLabelText('Open Mutation'));
  expect(useSelectionStore.getState().activeThreadId).toBe('thread-1');

  await user.keyboard('{Delete}');

  await waitFor(() => expect(useSelectionStore.getState().activeThreadId).toBeNull());
});
