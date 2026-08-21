import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAccountAvatarQuery,
  useAccountsQuery,
  useCancelQueueOperationMutation,
  useClearQueueHistoryMutation,
  useContactSuggestionsQuery,
  useConversationQuery,
  useDeleteThreadsMutation,
  useFetchMessageBodyMutation,
  useLabelsQuery,
  useMessageTriageMutation,
  useMoveThreadsMutation,
  useParseSearchQueryQuery,
  useQueueOperationsQuery,
  useRetryFailedOperationsMutation,
  useRetryQueueOperationMutation,
  useSearchThreadsQuery,
  useSenderAvatarQuery,
  useSetQueuePausedMutation,
  useThreadMutation,
  useThreadsQuery,
  useTraversalStatusQuery,
  useTriageMutation,
} from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { useLayoutStore } from '@/stores/layout';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import { useToastStore } from '@/stores/toast';
import { ipc } from '@/tests/ipc-mock';

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const thread = {
  id: 'thread-1',
  subject: 'Thread',
  sender: { display: '(No sender)', address: null },
  sentRecipient: null,
  latestAt: 0,
  messageCount: 1,
  isUnread: true,
  isStarred: false,
  hasAttachments: false,
  hasDraft: false,
};

beforeEach(() => {
  act(() => {
    useSelectionStore.setState({ activeMailboxId: 'INBOX' });
    useMultiSelectStore.setState({ selectedIds: new Set(['thread-1']), anchorId: 'thread-1' });
    useToastStore.setState({ toasts: [] });
    useSearchStore.setState({
      draft: '',
      submittedQuery: '',
      scope: { kind: 'default' },
      active: false,
      panelOpen: false,
    });
  });
});

describe('query hooks', () => {
  it('loads each account-scoped resource and stays disabled without its required id', async () => {
    const client = new QueryClient();
    const { result } = renderHook(
      () => ({
        accounts: useAccountsQuery(),
        labels: useLabelsQuery('account'),
        threads: useThreadsQuery('account', 'INBOX'),
        conversation: useConversationQuery('account', 'thread-1'),
        traversal: useTraversalStatusQuery('account'),
        disabledLabels: useLabelsQuery(null),
        disabledThreads: useThreadsQuery(null, null),
        disabledConversation: useConversationQuery(null, null),
      }),
      { wrapper: wrapper(client) },
    );
    await waitFor(() =>
      expect(
        result.current.accounts.isSuccess &&
          result.current.labels.isSuccess &&
          result.current.threads.isSuccess &&
          result.current.conversation.isSuccess &&
          result.current.traversal.isSuccess,
      ).toBe(true),
    );
    expect(result.current.disabledLabels.fetchStatus).toBe('idle');
    expect(result.current.disabledThreads.fetchStatus).toBe('idle');
    expect(result.current.disabledConversation.fetchStatus).toBe('idle');
  });

  it('loads conversations with the mailbox or active search entry scope', async () => {
    const client = new QueryClient();
    const calls: unknown[] = [];
    ipc.override('load_conversation', (args) => {
      calls.push(args);
      return { threadId: 'thread-1', subject: '', messages: [] };
    });
    const { rerender } = renderHook(() => useConversationQuery('account', 'thread-1'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls.at(-1)).toEqual({
      accountId: 'account',
      threadId: 'thread-1',
      imagePolicy: { alwaysLoad: false, allowedSenders: [], loadFor: [] },
      entryScope: { kind: 'mailbox', mailboxId: 'INBOX' },
    });
    act(() =>
      useSearchStore.setState({ active: true, scope: { kind: 'label', labelId: 'TRASH' } }),
    );
    rerender();
    await waitFor(() =>
      expect(calls.at(-1)).toEqual({
        accountId: 'account',
        threadId: 'thread-1',
        imagePolicy: { alwaysLoad: false, allowedSenders: [], loadFor: [] },
        entryScope: { kind: 'search', scope: { kind: 'label', labelId: 'TRASH' } },
      }),
    );
  });

  it('looks up contact suggestions only once an account and a two-character query are present', async () => {
    ipc.override('lookup_contacts', () => [{ address: 'a@example.com', displayName: 'A' }]);
    const client = new QueryClient();
    const { result, rerender } = renderHook(
      ({ accountId, query }: { accountId: string | null; query: string }) =>
        useContactSuggestionsQuery(accountId, query),
      { wrapper: wrapper(client), initialProps: { accountId: null as string | null, query: '' } },
    );
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ accountId: 'account', query: 'a' });
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ accountId: 'account', query: 'al' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([{ address: 'a@example.com', displayName: 'A' }]);
  });

  it('fetches a lazy body and invalidates its conversation', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.conversationThread('account', 'thread-1'), { messages: [] });
    const { result } = renderHook(() => useFetchMessageBodyMutation('account', 'thread-1'), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync('message-1');
    });
    await waitFor(() =>
      expect(
        client.getQueryState(queryKeys.conversationThread('account', 'thread-1'))?.isInvalidated,
      ).toBe(true),
    );
  });

  it('optimistically updates a thread and reports a failed update', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.threads('account', 'INBOX'), {
      pages: [{ items: [thread], nextCursor: null }],
      pageParams: [null],
    });
    const { result } = renderHook(() => useThreadMutation('account'), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({ threadId: 'thread-1', kind: 'star' });
    });
    expect(
      (
        client.getQueryData(queryKeys.threads('account', 'INBOX')) as {
          pages: Array<{ items: (typeof thread)[] }>;
        }
      ).pages[0].items[0].isStarred,
    ).toBe(true);
    ipc.override('mutate_threads', () => Promise.reject(new Error('offline')));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await expect(
      act(() => result.current.mutateAsync({ threadId: 'thread-1', kind: 'unread' })),
    ).rejects.toThrow('offline');
    expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/couldn’t update/i);
    expect(error).toHaveBeenCalledWith('ipc mutate_threads failed: offline');
    error.mockRestore();
  });

  it('applies triage to threads and messages and keeps the selection', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.threads('account', 'INBOX'), {
      pages: [{ items: [thread], nextCursor: null }],
      pageParams: [null],
    });
    client.setQueryData(queryKeys.conversationThread('account', 'thread-1'), {
      messages: [{ id: 'message-1', labelIds: ['INBOX'], isUnread: true, isStarred: false }],
    });
    const hooks = renderHook(
      () => ({
        threads: useTriageMutation('account'),
        messages: useMessageTriageMutation('account'),
      }),
      { wrapper: wrapper(client) },
    );
    await act(async () => {
      await hooks.result.current.threads.mutateAsync({
        threadIds: ['thread-1'],
        add: ['STARRED'],
        remove: ['UNREAD'],
      });
    });
    await act(async () => {
      await hooks.result.current.messages.mutateAsync({
        threadId: 'thread-1',
        messageIds: ['message-1'],
        add: ['STARRED'],
        remove: ['UNREAD'],
      });
    });
    expect([...useMultiSelectStore.getState().selectedIds]).toEqual(['thread-1']);
    const message = (
      client.getQueryData(queryKeys.conversationThread('account', 'thread-1')) as {
        messages: Array<{ isStarred: boolean; isUnread: boolean }>;
      }
    ).messages[0];
    expect(message).toMatchObject({ isStarred: true, isUnread: false });
  });

  it('shows a thread label change before the request settles', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.labels('account'), [
      {
        id: 'Label_1',
        name: 'Clients',
        kind: 'user',
        color: null,
        messageCount: 0,
        unreadCount: 0,
      },
      {
        id: 'Label_2',
        name: 'Invoices',
        kind: 'user',
        color: null,
        messageCount: 0,
        unreadCount: 0,
      },
    ]);
    client.setQueryData(queryKeys.threads('account', 'INBOX'), {
      pages: [{ items: [{ ...thread, labelIndicators: ['Invoices'] }], nextCursor: null }],
      pageParams: [null],
    });
    client.setQueryData(queryKeys.conversationThread('account', 'thread-1'), {
      messages: [{ id: 'message-1', labelIds: ['INBOX', 'Label_2'] }],
    });
    ipc.override('mutate_threads', () => new Promise<never>(() => undefined));
    const { result } = renderHook(() => useTriageMutation('account'), { wrapper: wrapper(client) });
    act(() =>
      result.current.mutate({ threadIds: ['thread-1'], add: ['Label_1'], remove: ['Label_2'] }),
    );
    await waitFor(() => {
      const page = (
        client.getQueryData(queryKeys.threads('account', 'INBOX')) as {
          pages: Array<{ items: { labelIndicators: string[] }[] }>;
        }
      ).pages[0];
      expect(page.items[0].labelIndicators).toEqual(['Clients']);
    });
    expect(
      (
        client.getQueryData(queryKeys.conversationThread('account', 'thread-1')) as {
          messages: { labelIds: string[] }[];
        }
      ).messages[0].labelIds,
    ).toEqual(['INBOX', 'Label_1']);
  });
});

describe('avatar queries', () => {
  beforeEach(() => {
    useLayoutStore.setState({ showSenderAvatars: true });
  });

  it('resolves the sender-avatar path through the asset URL resolver', async () => {
    ipc.override('read_sender_avatar', '/cache/senders/example.png');
    const { result } = renderHook(() => useSenderAvatarQuery('example.com'), {
      wrapper: wrapper(new QueryClient()),
    });
    await waitFor(() =>
      expect(result.current.data).toBe('asset://localhost/%2Fcache%2Fsenders%2Fexample.png'),
    );
  });

  it('does not issue a lookup at all while the preference is off', async () => {
    useLayoutStore.setState({ showSenderAvatars: false });
    const client = new QueryClient();
    const { result } = renderHook(() => useSenderAvatarQuery('example.com'), {
      wrapper: wrapper(client),
    });
    expect(result.current.fetchStatus).toBe('idle');

    expect(client.getQueryState(queryKeys.senderAvatar('example.com'))?.dataUpdateCount).toBe(0);
  });

  it('treats a rejected sender-avatar invoke identically to "no image", without surfacing an error', async () => {
    ipc.override('read_sender_avatar', () => Promise.reject(new Error('command not registered')));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { result } = renderHook(() => useSenderAvatarQuery('example.com'), {
      wrapper: wrapper(new QueryClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
    expect(result.current.isError).toBe(false);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('treats a rejected account-avatar invoke identically to "no image"', async () => {
    ipc.override('read_account_avatar', () => Promise.reject(new Error('command not registered')));
    const { result } = renderHook(() => useAccountAvatarQuery('account-1'), {
      wrapper: wrapper(new QueryClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('is not gated by the preference — the account photograph involves no third-party lookup', async () => {
    useLayoutStore.setState({ showSenderAvatars: false });
    ipc.override('read_account_avatar', null);
    const { result } = renderHook(() => useAccountAvatarQuery('account-1'), {
      wrapper: wrapper(new QueryClient()),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});

describe('search query hooks', () => {
  it('stays idle without a non-blank query and fetches once one is supplied', async () => {
    ipc.override('search_threads', { items: [], nextCursor: null, total: 0 });
    const client = new QueryClient();
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) =>
        useSearchThreadsQuery('account', query, { kind: 'default' }),
      { wrapper: wrapper(client), initialProps: { query: '' } },
    );
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ query: 'from:anna' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it('parses a query only once it is non-blank', async () => {
    ipc.override('parse_search_query', {
      hasTextTerm: true,
      from: 'anna',
      to: null,
      subject: null,
      includes: [],
      excludes: [],
      predicates: [],
    });
    const client = new QueryClient();
    const { result, rerender } = renderHook(
      ({ query }: { query: string }) => useParseSearchQueryQuery(query),
      { wrapper: wrapper(client), initialProps: { query: '' } },
    );
    expect(result.current.fetchStatus).toBe('idle');
    rerender({ query: 'from:anna' });
    await waitFor(() => expect(result.current.data?.from).toBe('anna'));
  });
});

describe('search optimistic removal', () => {
  const sentThread = {
    ...thread,
    id: 'thread-sent',
    isUnread: false,
  };

  function seedSearchCache(client: QueryClient) {
    client.setQueryData(queryKeys.search('account', 'from:anna', { kind: 'default' }), {
      pages: [{ items: [sentThread], nextCursor: null, total: 1 }],
      pageParams: [null],
    });
  }

  it('removes a row from the default-scoped search cache when it is deleted, mirroring the Sent-mailbox rule', async () => {
    const client = new QueryClient();
    seedSearchCache(client);
    act(() => useSearchStore.setState({ scope: { kind: 'default' } }));
    const { result } = renderHook(() => useDeleteThreadsMutation('account'), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ threadIds: ['thread-sent'] });
    });
    const page = (
      client.getQueryData(queryKeys.search('account', 'from:anna', { kind: 'default' })) as {
        pages: Array<{ items: (typeof sentThread)[]; total: number }>;
      }
    ).pages[0];
    expect(page.items).toHaveLength(0);
    expect(page.total).toBe(0);
  });

  it('keeps a row in a Trash-scoped search when it is deleted', async () => {
    const client = new QueryClient();
    client.setQueryData(
      queryKeys.search('account', 'from:anna', { kind: 'label', labelId: 'TRASH' }),
      {
        pages: [{ items: [sentThread], nextCursor: null, total: 1 }],
        pageParams: [null],
      },
    );
    act(() => useSearchStore.setState({ scope: { kind: 'label', labelId: 'TRASH' } }));
    const { result } = renderHook(() => useDeleteThreadsMutation('account'), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ threadIds: ['thread-sent'] });
    });
    const page = (
      client.getQueryData(
        queryKeys.search('account', 'from:anna', { kind: 'label', labelId: 'TRASH' }),
      ) as { pages: Array<{ items: (typeof sentThread)[]; total: number }> }
    ).pages[0];
    expect(page.items).toHaveLength(1);
  });

  it('removes a row from a default-scoped search when it is moved to Spam', async () => {
    const client = new QueryClient();
    seedSearchCache(client);
    act(() => useSearchStore.setState({ scope: { kind: 'default' } }));
    const { result } = renderHook(() => useMoveThreadsMutation('account'), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ threadIds: ['thread-sent'], destination: 'SPAM' });
    });
    const page = (
      client.getQueryData(queryKeys.search('account', 'from:anna', { kind: 'default' })) as {
        pages: Array<{ items: (typeof sentThread)[] }>;
      }
    ).pages[0];
    expect(page.items).toHaveLength(0);
  });

  it('keeps star/read changes visible in the search cache rather than removing the row', async () => {
    const client = new QueryClient();
    seedSearchCache(client);
    act(() => useSearchStore.setState({ scope: { kind: 'default' } }));
    const { result } = renderHook(() => useTriageMutation('account'), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current.mutateAsync({
        threadIds: ['thread-sent'],
        add: ['STARRED'],
        remove: [],
      });
    });
    const page = (
      client.getQueryData(queryKeys.search('account', 'from:anna', { kind: 'default' })) as {
        pages: Array<{ items: { id: string; isStarred: boolean }[] }>;
      }
    ).pages[0];
    expect(page.items).toHaveLength(1);
    expect(page.items[0].isStarred).toBe(true);
  });
});

describe('queue hooks', () => {
  it('reads the queue snapshot', async () => {
    const client = new QueryClient();
    ipc.override('read_queue_operations', []);
    const { result } = renderHook(() => useQueueOperationsQuery(), { wrapper: wrapper(client) });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual([]);
  });

  it('cancels an operation and reports whether it applied', async () => {
    const client = new QueryClient();
    ipc.override('cancel_queue_operation', false);
    const { result } = renderHook(() => useCancelQueueOperationMutation(), {
      wrapper: wrapper(client),
    });
    const applied = await act(async () => result.current.mutateAsync('op-1'));
    expect(applied).toBe(false);
  });

  it('retries a single operation', async () => {
    const client = new QueryClient();
    const retry = vi.fn(() => true);
    ipc.override('retry_queue_operation', retry);
    const { result } = renderHook(() => useRetryQueueOperationMutation(), {
      wrapper: wrapper(client),
    });
    await act(async () => result.current.mutateAsync('op-1'));
    expect(retry).toHaveBeenCalledWith({ operationId: 'op-1' });
  });

  it('retries every failed operation, optionally scoped to an account', async () => {
    const client = new QueryClient();
    const retryAll = vi.fn(() => 2);
    ipc.override('retry_failed_operations', retryAll);
    const { result } = renderHook(() => useRetryFailedOperationsMutation(), {
      wrapper: wrapper(client),
    });
    await act(async () => result.current.mutateAsync('account-1'));
    expect(retryAll).toHaveBeenCalledWith({ accountId: 'account-1' });
  });

  it('clears queue history', async () => {
    const client = new QueryClient();
    const clear = vi.fn();
    ipc.override('clear_queue_history', clear);
    const { result } = renderHook(() => useClearQueueHistoryMutation(), {
      wrapper: wrapper(client),
    });
    await act(async () => result.current.mutateAsync(undefined));
    expect(clear).toHaveBeenCalledWith({ accountId: null });
  });

  it('sets the paused flag at the requested scope', async () => {
    const client = new QueryClient();
    const setPaused = vi.fn(() => true);
    ipc.override('set_queue_paused', setPaused);
    const { result } = renderHook(() => useSetQueuePausedMutation(), { wrapper: wrapper(client) });
    await act(async () => result.current.mutateAsync({ scope: { scope: 'global' }, paused: true }));
    expect(setPaused).toHaveBeenCalledWith({ scope: { scope: 'global' }, paused: true });
  });

  it('surfaces a toast when a queue control command fails', async () => {
    const client = new QueryClient();
    ipc.override('set_queue_paused', () => {
      throw new Error('boom');
    });
    const { result } = renderHook(() => useSetQueuePausedMutation(), { wrapper: wrapper(client) });
    await act(async () => {
      await result.current
        .mutateAsync({ scope: { scope: 'global' }, paused: true })
        .catch(() => {});
    });
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'Couldn’t update the pause state.',
    );
  });
});
