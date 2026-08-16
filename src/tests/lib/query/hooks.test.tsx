import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAccountAvatarQuery,
  useAccountsQuery,
  useContactSuggestionsQuery,
  useConversationQuery,
  useFetchMessageBodyMutation,
  useLabelsQuery,
  useMessageTriageMutation,
  useSenderAvatarQuery,
  useThreadMutation,
  useThreadsQuery,
  useTraversalStatusQuery,
  useTriageMutation,
} from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { useLayoutStore } from '@/stores/layout';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
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
    client.setQueryData(queryKeys.conversation('account', 'thread-1'), { messages: [] });
    const { result } = renderHook(() => useFetchMessageBodyMutation('account', 'thread-1'), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync('message-1');
    });
    await waitFor(() =>
      expect(
        client.getQueryState(queryKeys.conversation('account', 'thread-1'))?.isInvalidated,
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

  it('applies triage to threads and messages, then clears the selection', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.threads('account', 'INBOX'), {
      pages: [{ items: [thread], nextCursor: null }],
      pageParams: [null],
    });
    client.setQueryData(queryKeys.conversation('account', 'thread-1'), {
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
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
    const message = (
      client.getQueryData(queryKeys.conversation('account', 'thread-1')) as {
        messages: Array<{ isStarred: boolean; isUnread: boolean }>;
      }
    ).messages[0];
    expect(message).toMatchObject({ isStarred: true, isUnread: false });
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
    // "Never issued" means no fetch was ever started — TanStack still
    // creates an observer entry for a disabled query, but its update count
    // must stay at zero because `queryFn` never ran.
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
