import { act, renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it } from 'vitest';
import {
  useDeleteThreadsMutation,
  useMoveThreadsMutation,
  useTriageMutation,
} from '@/lib/query/mutations';
import { queryKeys } from '@/lib/query/keys';
import { useSearchStore } from '@/stores/search';
import { resetHookTestStores, thread, wrapper } from '@/tests/lib/query/hooks-helpers';

beforeEach(() => {
  resetHookTestStores();
});

const sentThread = {
  ...thread,
  id: 'thread-sent',
  isUnread: false,
};

function seedSearchCache(client: QueryClient) {
  client.setQueryData(queryKeys.search('account', 'from:anna', { kind: 'default' }), {
    pages: [{ items: [sentThread], nextCursor: null }],
    pageParams: [null],
  });
  client.setQueryData(queryKeys.searchTotal('account', 'from:anna', { kind: 'default' }), 1);
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
  const page = client.getQueryData<{
    pages: Array<{ items: (typeof sentThread)[] }>;
  }>(queryKeys.search('account', 'from:anna', { kind: 'default' }))?.pages[0];
  expect(page?.items).toHaveLength(0);
  expect(
    client.getQueryData(queryKeys.searchTotal('account', 'from:anna', { kind: 'default' })),
  ).toBe(0);
});

it('keeps a row in a Trash-scoped search when it is deleted', async () => {
  const client = new QueryClient();
  client.setQueryData(
    queryKeys.search('account', 'from:anna', { kind: 'label', labelId: 'TRASH' }),
    {
      pages: [{ items: [sentThread], nextCursor: null }],
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
  const page = client.getQueryData<{ pages: Array<{ items: (typeof sentThread)[] }> }>(
    queryKeys.search('account', 'from:anna', { kind: 'label', labelId: 'TRASH' }),
  )?.pages[0];
  expect(page?.items).toHaveLength(1);
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
  const page = client.getQueryData<{
    pages: Array<{ items: (typeof sentThread)[] }>;
  }>(queryKeys.search('account', 'from:anna', { kind: 'default' }))?.pages[0];
  expect(page?.items).toHaveLength(0);
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
  const page = client.getQueryData<{
    pages: Array<{ items: { id: string; isStarred: boolean }[] }>;
  }>(queryKeys.search('account', 'from:anna', { kind: 'default' }))?.pages[0];
  expect(page?.items).toHaveLength(1);
  expect(page?.items[0].isStarred).toBe(true);
});
