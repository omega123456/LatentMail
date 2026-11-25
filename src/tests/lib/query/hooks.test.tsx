import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useAccountAvatarQuery,
  useAccountsQuery,
  useContactSuggestionsQuery,
  useConversationQuery,
  useFetchMessageBodyMutation,
  useLabelsQuery,
  useMessageBodyQuery,
  useSenderAvatarQuery,
  useThreadsQuery,
  useTraversalStatusQuery,
} from '@/lib/query/hooks';
import { useMessageTriageMutation, useTriageMutation } from '@/lib/query/mutations';
import { queryKeys } from '@/lib/query/keys';
import { useLayoutStore } from '@/stores/layout';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSearchStore } from '@/stores/search';
import { ipc } from '@/tests/ipc-mock';
import { resetHookTestStores, thread, wrapper } from '@/tests/lib/query/hooks-helpers';

beforeEach(() => {
  resetHookTestStores();
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
    ipc.override('load_conversation', (request) => {
      calls.push(request);
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

  it('loads cached message bodies by policy and leaves Gmail fetch refresh to events', async () => {
    const client = new QueryClient();
    const bodies: unknown[] = [];
    ipc.override('load_message_body', (request) => {
      bodies.push(request);
      return {
        htmlBody: '<p>Cached</p>',
        plainBody: null,
        htmlPresence: 'present' as const,
        truncated: false,
        remoteImagesBlocked: false,
        remoteImagesAllowed: false,
        inlineImagesPending: false,
      };
    });
    const { result } = renderHook(
      () => ({
        body: useMessageBodyQuery('account', 'message-1'),
        fetch: useFetchMessageBodyMutation('account'),
      }),
      {
        wrapper: wrapper(client),
      },
    );
    await waitFor(() => expect(result.current.body.isSuccess).toBe(true));
    expect(bodies).toEqual([
      {
        accountId: 'account',
        messageId: 'message-1',
        imagePolicy: { alwaysLoad: false, allowedSenders: [], loadFor: [] },
        entryScope: { kind: 'mailbox', mailboxId: 'INBOX' },
      },
    ]);
    await act(async () => {
      await result.current.fetch.mutateAsync('message-1');
    });
    expect(
      client.getQueryState(queryKeys.conversationThread('account', 'thread-1'))?.isInvalidated,
    ).not.toBe(true);
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
    const message = client.getQueryData<{
      messages: Array<{ isStarred: boolean; isUnread: boolean }>;
    }>(queryKeys.conversationThread('account', 'thread-1'))?.messages[0];
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
      const page = client.getQueryData<{
        pages: Array<{ items: { labelIndicators: string[] }[] }>;
      }>(queryKeys.threads('account', 'INBOX'))?.pages[0];
      expect(page?.items[0].labelIndicators).toEqual(['Clients']);
    });
    expect(
      client.getQueryData<{
        messages: { labelIds: string[] }[];
      }>(queryKeys.conversationThread('account', 'thread-1'))?.messages[0].labelIds,
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
