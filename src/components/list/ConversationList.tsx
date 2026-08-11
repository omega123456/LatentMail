import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useMailVirtualizer } from '@/lib/react-virtual';
import { ErrorState } from '@/components/states/ErrorState';
import { EmptyState } from '@/components/states/EmptyState';
import { LoadingState } from '@/components/states/LoadingState';
import { useThreadMutation, useThreadsQuery } from '@/lib/query/hooks';
import { mapThreadToRow } from '@/lib/query/mappers';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import type { Conversation } from '@/lib/types/conversation';
import { conversationFixtures } from './conversation-fixtures';
import { ConversationRow } from './ConversationRow';

type ListState = 'ready' | 'loading' | 'empty' | 'error';
const emptyCopy: Record<string, string> = {
  INBOX: 'Your Inbox is clear.',
  STARRED: 'No starred conversations.',
  SENT: 'No sent conversations.',
  TRASH: 'Trash is empty.',
};
const fixtureState = (): ListState =>
  window.__LATENTMAIL_PLAYWRIGHT_IPC__
    ? (new URLSearchParams(window.location.search).get('listState') as ListState) || 'ready'
    : 'ready';

export function ConversationList({
  threads = conversationFixtures,
  pages,
  state = fixtureState(),
  onRetry,
  onLoadMore,
  onThreadMutation,
}: {
  threads?: Conversation[];
  pages?: Conversation[][];
  state?: ListState;
  onRetry?: () => void;
  /** Real (Query-driven) usage fetches pages lazily instead of slicing an
   * already-loaded `pages` array — the container passes this instead. */
  onLoadMore?: () => void;
  onThreadMutation?: (threadId: string, kind: 'star' | 'unstar' | 'read') => void;
}) {
  'use no memo';
  const parentRef = useRef<HTMLDivElement>(null);
  const previousRows = useRef(threads);
  const previousHeight = useRef(0);
  const density = useLayoutStore((value) => value.density);
  const mailboxId = useSelectionStore((value) => value.activeMailboxId) ?? 'INBOX';
  const cursor = useSelectionStore((value) => value.keyboardCursor);
  const setCursor = useSelectionStore((value) => value.setKeyboardCursor);
  const setThread = useSelectionStore((value) => value.setActiveThreadId);
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState(() => pages?.[0] ?? threads);
  const [source, setSource] = useState(() => ({ pages, threads, mailboxId }));
  if (source.pages !== pages || source.threads !== threads || source.mailboxId !== mailboxId) {
    setSource({ pages, threads, mailboxId });
    setPage(0);
    setRows(pages?.[0] ?? threads);
  }
  useLayoutEffect(() => {
    const parent = parentRef.current;
    if (
      parent &&
      previousRows.current[0] &&
      rows[0] &&
      previousRows.current[0].id !== rows[0].id &&
      parent.scrollTop > 0
    )
      parent.scrollTop += parent.scrollHeight - previousHeight.current;
    previousRows.current = rows;
    previousHeight.current = parent?.scrollHeight ?? 0;
  }, [rows]);
  const rowHeight = density === 'compact' ? 44 : density === 'comfortable' ? 66 : 88;
  const virtualizer = useMailVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [density, virtualizer]);
  const open = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setCursor(index);
      setThread(row.id);
      if (row.unread) onThreadMutation?.(row.id, 'read');
      setRows((current) =>
        current.map((item, itemIndex) => (itemIndex === index ? { ...item, unread: false } : item)),
      );
    },
    [onThreadMutation, rows, setCursor, setThread],
  );
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        !['j', 'J', 'ArrowDown', 'k', 'K', 'ArrowUp', 'Enter', 'o', 'O', 'Escape'].includes(
          event.key,
        )
      )
        return;
      if (event.key === 'Escape') {
        setThread(null);
        setCursor(null);
        return;
      }
      if (event.key === 'Enter' || event.key === 'o' || event.key === 'O') {
        if (cursor !== null) open(cursor);
        return;
      }
      event.preventDefault();
      const next =
        event.key === 'j' || event.key === 'J' || event.key === 'ArrowDown'
          ? Math.min(rows.length - 1, (cursor ?? -1) + 1)
          : Math.max(0, (cursor ?? rows.length) - 1);
      open(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cursor, open, rows, setCursor, setThread, virtualizer]);
  const content = (() => {
    if (state === 'loading') return <LoadingState>Loading conversations…</LoadingState>;
    if (state === 'empty')
      return <EmptyState>{emptyCopy[mailboxId] ?? 'No conversations in this mailbox.'}</EmptyState>;
    if (state === 'error')
      return (
        <ErrorState>
          Couldn’t load conversations.{' '}
          <button
            onClick={onRetry}
            className="underline focus-visible:outline-2 focus-visible:outline-primary"
          >
            Retry
          </button>
        </ErrorState>
      );
    const items = virtualizer.getVirtualItems();
    const visible = items.length
      ? items
      : rows.map((_, index) => ({ key: index, index, start: index * rowHeight }));
    return (
      <>
        <div style={{ height: `${virtualizer.getTotalSize()}px` }} className="relative">
          {visible.map((item) => (
            <div
              key={item.key}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <ConversationRow
                conversation={rows[item.index]}
                density={density}
                active={cursor === item.index}
                mailboxId={mailboxId}
                onOpen={() => open(item.index)}
                onStar={() => {
                  const row = rows[item.index];
                  onThreadMutation?.(row.id, row.starred ? 'unstar' : 'star');
                  setRows((current) =>
                    current.map((currentRow, index) =>
                      index === item.index ? { ...currentRow, starred: !currentRow.starred } : currentRow,
                    ),
                  );
                }}
              />
            </div>
          ))}
        </div>
        <p className="p-stack-gap-sm text-center text-label-sm text-secondary dark:text-dark-secondary">
          {pages && page < pages.length - 1
            ? 'Loading more conversations…'
            : 'End of conversations'}
        </p>
      </>
    );
  })();
  const loadNextPage = () => {
    if (!pages || page >= pages.length - 1) return;
    setRows((current) => [...current, ...pages[page + 1]]);
    setPage((current) => current + 1);
  };
  return (
    <div
      ref={parentRef}
      data-testid="conversation-list"
      className="min-h-0 flex-1 overflow-auto p-stack-gap-sm"
      onScroll={() => {
        if (
          parentRef.current &&
          parentRef.current.scrollTop + parentRef.current.clientHeight >=
            parentRef.current.scrollHeight - rowHeight
        ) {
          loadNextPage();
          onLoadMore?.();
        }
      }}
    >
      {content}
    </div>
  );
}

/** Composition-root wiring: fetches the active account/mailbox's threads via
 * `useThreadsQuery` and hands the mapped rows to the presentational
 * `ConversationList` above. Keeps `ConversationList` itself fixture-friendly
 * for unit tests. */
export function ConversationListContainer() {
  const accountId = useSelectionStore((value) => value.activeAccountId);
  const mailboxId = useSelectionStore((value) => value.activeMailboxId) ?? 'INBOX';
  const query = useThreadsQuery(accountId, mailboxId);
  const mutation = useThreadMutation(accountId);
  const rows = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.items.map(mapThreadToRow)),
    [query.data],
  );
  // `?listState=` still lets Playwright screenshot the loading/empty/error
  // states deterministically instead of racing a real (instantly-resolving
  // mock) IPC call.
  const forcedState = fixtureState();
  const state: ListState =
    forcedState !== 'ready'
      ? forcedState
      : query.isError
        ? 'error'
        : query.isPending
          ? 'loading'
          : rows.length === 0
            ? 'empty'
            : 'ready';
  return (
    <ConversationList
      threads={rows}
      state={state}
      onRetry={() => void query.refetch()}
      onLoadMore={() => {
        if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
      }}
      onThreadMutation={
        accountId ? (threadId, kind) => mutation.mutate({ threadId, kind }) : undefined
      }
    />
  );
}
