import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it } from 'vitest';
import {
  RETAINED_THREAD_PAGES,
  useParseSearchQueryQuery,
  useSearchThreadsQuery,
  useThreadsQuery,
} from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { ipc } from '@/tests/ipc-mock';
import { resetHookTestStores, thread, wrapper } from '@/tests/lib/query/hooks-helpers';

beforeEach(() => {
  resetHookTestStores();
});

type ThreadCursor = { latestAt: number; id: string };
type RecordedThreadCommand = { command: string; request: unknown };
type CachedThreadPages = { pages: Array<{ items: (typeof thread)[] }> };

const PAGES_AFTER_FIRST_FETCH = 2;
const SEARCH_TEXT = 'from:anna';
const mailboxKey = queryKeys.threads('account', 'INBOX');
const searchKey = queryKeys.search('account', SEARCH_TEXT, { kind: 'default' });
const firstPageCursor = { latestAt: 0, id: '0' };

function threadPageAt(cursor: ThreadCursor | null) {
  const index = cursor?.latestAt ?? 0;
  const hasNextPage = index < RETAINED_THREAD_PAGES;
  const hasPreviousPage = index > 0;
  return {
    items: [{ ...thread, id: `thread-${index}` }],
    nextCursor: hasNextPage ? { latestAt: index + 1, id: String(index + 1) } : null,
    previousCursor: hasPreviousPage ? { latestAt: index - 1, id: String(index - 1) } : null,
  };
}

function recordPagedThreadCommands() {
  const calls: RecordedThreadCommand[] = [];
  ipc.override('list_threads', (request) => {
    calls.push({ command: 'list_threads', request: request });
    return threadPageAt(request.cursor ?? null);
  });
  ipc.override('search_threads', (request) => {
    calls.push({ command: 'search_threads', request: request });
    return threadPageAt(request.cursor ?? null);
  });
  return calls;
}

function renderMailboxAndSearch(client: QueryClient) {
  return renderHook(
    () => ({
      mailbox: useThreadsQuery('account', 'INBOX'),
      search: useSearchThreadsQuery('account', SEARCH_TEXT, { kind: 'default' }),
    }),
    { wrapper: wrapper(client) },
  );
}

type MailboxAndSearchResult = ReturnType<typeof renderMailboxAndSearch>['result'];

function bothQueriesSucceeded(result: MailboxAndSearchResult) {
  return result.current.mailbox.isSuccess && result.current.search.isSuccess;
}

function cachedPages(client: QueryClient, key: readonly unknown[]) {
  return client.getQueryData<CachedThreadPages>(key)?.pages;
}

function firstCachedThreadId(client: QueryClient, key: readonly unknown[]) {
  return cachedPages(client, key)?.[0].items[0].id;
}

async function fetchEveryRetainedPage(result: MailboxAndSearchResult, client: QueryClient) {
  for (let index = 0; index < RETAINED_THREAD_PAGES; index += 1) {
    const expectedPageCount = Math.min(RETAINED_THREAD_PAGES, index + PAGES_AFTER_FIRST_FETCH);
    await act(async () => {
      await result.current.mailbox.fetchNextPage();
    });
    expect(cachedPages(client, mailboxKey)).toHaveLength(expectedPageCount);
    await act(async () => {
      await result.current.search.fetchNextPage();
    });
    expect(cachedPages(client, searchKey)).toHaveLength(expectedPageCount);
  }
}

async function fetchPreviousPages(result: MailboxAndSearchResult) {
  await act(async () => {
    await result.current.mailbox.fetchPreviousPage();
    await result.current.search.fetchPreviousPage();
  });
}

function expectBackwardFetchFromFirstPage(calls: RecordedThreadCommand[], command: string) {
  expect(calls).toContainEqual({
    command: command,
    request: expect.objectContaining({
      cursor: firstPageCursor,
      direction: 'backward',
    }),
  });
}

it('retains five mailbox and search pages and restores the previous page', async () => {
  const calls = recordPagedThreadCommands();
  const client = new QueryClient();
  const { result } = renderMailboxAndSearch(client);
  await waitFor(() => expect(bothQueriesSucceeded(result)).toBe(true));
  expect(result.current.mailbox.hasNextPage).toBe(true);
  expect(result.current.search.hasNextPage).toBe(true);

  await fetchEveryRetainedPage(result, client);
  expect(cachedPages(client, mailboxKey)).toHaveLength(RETAINED_THREAD_PAGES);
  expect(cachedPages(client, searchKey)).toHaveLength(RETAINED_THREAD_PAGES);

  await fetchPreviousPages(result);
  expect(firstCachedThreadId(client, mailboxKey)).toBe('thread-0');
  expect(firstCachedThreadId(client, searchKey)).toBe('thread-0');
  expectBackwardFetchFromFirstPage(calls, 'list_threads');
  expectBackwardFetchFromFirstPage(calls, 'search_threads');
});

it('stays idle without a non-blank query and fetches once one is supplied', async () => {
  ipc.override('search_threads', { items: [], nextCursor: null });
  const client = new QueryClient();
  const { result, rerender } = renderHook(
    ({ query }: { query: string }) => useSearchThreadsQuery('account', query, { kind: 'default' }),
    { wrapper: wrapper(client), initialProps: { query: '' } },
  );
  expect(result.current.fetchStatus).toBe('idle');
  rerender({ query: SEARCH_TEXT });
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
  rerender({ query: SEARCH_TEXT });
  await waitFor(() => expect(result.current.data?.from).toBe('anna'));
});
