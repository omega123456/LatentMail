import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { Info } from 'lucide-react';
import { useMailVirtualizer } from '@/lib/react-virtual';
import { ErrorState } from '@/components/states/ErrorState';
import { EmptyState } from '@/components/states/EmptyState';
import { LoadingState } from '@/components/states/LoadingState';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import { useCommands } from '@/lib/keyboard/useCommands';
import {
  useLabelsQuery,
  useAccountsQuery,
  useConversationQuery,
  useSearchThreadsQuery,
  useThreadsQuery,
  useThreadTriageIntentMutation,
  useTraversalStatusQuery,
  type ThreadTriageIntent,
} from '@/lib/query/hooks';
import { mapConversation, mapLabelsToUserLabels, mapThreadToRow } from '@/lib/query/mappers';
import { openEditDraft, openForward, openReply } from '@/lib/compose/entry';
import { useLayoutStore } from '@/stores/layout';
import { selectIsMultiSelectActive, useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import type { Conversation } from '@/lib/types/conversation';
import { conversationFixtures } from './conversation-fixtures';
import { ConversationRow } from './ConversationRow';

type ListState = 'ready' | 'loading' | 'empty' | 'syncing' | 'error' | 'searchEmpty';
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

function intersectSystemLabelIds(conversations: Conversation[]): string[] {
  if (conversations.length === 0) return [];
  const [first, ...rest] = conversations;
  return (first.systemLabelIds ?? []).filter((id) =>
    rest.every((conversation) => (conversation.systemLabelIds ?? []).includes(id)),
  );
}

export function ConversationList({
  threads = conversationFixtures,
  pages,
  state = fixtureState(),
  onRetry,
  onLoadMore,
  onLoadPrevious,
  errorMessage,
  allLabels = [],
  onTriage,
  syncProgress,
  onCompose,
  composeTargetThreadId,
  searchQueryText,
  searchIncomplete = false,
}: {
  threads?: Conversation[];
  pages?: Conversation[][];
  state?: ListState;
  onRetry?: () => void;
  errorMessage?: string;
  onLoadMore?: () => void;
  onLoadPrevious?: () => void;
  allLabels?: LabelMenuEntry[];
  onTriage?: (threadIds: string[], intent: ThreadTriageIntent) => void;
  syncProgress?: { persistedCount: number; discoveredCount: number };
  onCompose?: (threadId: string, action: 'reply' | 'reply-all' | 'forward' | 'edit-draft') => void;
  composeTargetThreadId?: string | null;
  searchQueryText?: string;
  searchIncomplete?: boolean;
}) {
  'use no memo';
  const parentRef = useRef<HTMLDivElement>(null);
  const previousRows = useRef(threads);
  const previousHeight = useRef(0);
  const density = useLayoutStore((value) => value.density);
  const mailboxId = useSelectionStore((value) => value.activeMailboxId) ?? 'INBOX';
  const searchActive = useSearchStore((value) => value.active);
  const cursor = useSelectionStore((value) => value.keyboardCursor);
  const setCursor = useSelectionStore((value) => value.setKeyboardCursor);
  const setThread = useSelectionStore((value) => value.setActiveThreadId);
  const flashThreadId = useSelectionStore((value) => value.flashThreadId);
  const setFlashThreadId = useSelectionStore((value) => value.setFlashThreadId);
  const selectedIds = useMultiSelectStore((value) => value.selectedIds);
  const multiSelectActive = useMultiSelectStore(selectIsMultiSelectActive);
  const toggleSelected = useMultiSelectStore((value) => value.toggle);
  const selectRange = useMultiSelectStore((value) => value.selectRange);
  const selectAll = useMultiSelectStore((value) => value.selectAll);
  const pruneSelected = useMultiSelectStore((value) => value.prune);
  const clearMultiSelect = useMultiSelectStore((value) => value.clear);
  const [fixturePage, setFixturePage] = useState(0);
  const [source, setSource] = useState(() => ({ pages, threads, mailboxId }));
  if (source.pages !== pages || source.threads !== threads || source.mailboxId !== mailboxId) {
    setSource({ pages, threads, mailboxId });
    setFixturePage(0);
  }
  const rows = useMemo(
    () => (pages ? pages.slice(0, fixturePage + 1).flat() : threads),
    [pages, fixturePage, threads],
  );
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
  const rowHeight = density === 'compact' ? 48 : density === 'comfortable' ? 68 : 88;
  const virtualizer = useMailVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 5,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [density, virtualizer]);
  useLayoutEffect(() => {
    previousRows.current = [];
    previousHeight.current = 0;
    virtualizer.scrollToOffset(0);
  }, [mailboxId, searchActive, virtualizer]);
  useEffect(() => {
    if (!flashThreadId) return;
    const index = rows.findIndex((row) => row.id === flashThreadId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: 'auto' });
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) setFlashThreadId(null);
  }, [flashThreadId, rows, setFlashThreadId, virtualizer]);
  const open = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      setCursor(index);
      setThread(row.id);
      if (row.unread) onTriage?.([row.id], { kind: 'label', add: [], remove: ['UNREAD'] });
    },
    [onTriage, rows, setCursor, setThread],
  );
  const moveCursor = useCallback(
    (delta: number) => {
      if (rows.length === 0) return;
      const from = cursor ?? (delta > 0 ? -1 : rows.length);
      const next = Math.min(rows.length - 1, Math.max(0, from + delta));
      open(next);
      virtualizer.scrollToIndex(next, { align: 'auto' });
    },
    [cursor, open, rows.length, virtualizer],
  );
  const visibleRowCount = () =>
    Math.max(1, Math.floor((parentRef.current?.clientHeight ?? rowHeight) / rowHeight) - 1);
  const currentFolderId = searchActive ? undefined : mailboxId;
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const selectionSystemLabelIds = useMemo(
    () => intersectSystemLabelIds(rows.filter((row) => selectedIds.has(row.id))),
    [rows, selectedIds],
  );
  useCommands({
    moveCursorDown: (event) => {
      event.preventDefault();
      moveCursor(1);
    },
    moveCursorUp: (event) => {
      event.preventDefault();
      moveCursor(-1);
    },
    pageCursorDown: (event) => {
      event.preventDefault();
      moveCursor(visibleRowCount());
    },
    pageCursorUp: (event) => {
      event.preventDefault();
      moveCursor(-visibleRowCount());
    },
    openConversation: () => {
      if (cursor !== null) open(cursor);
    },
    dismiss: () => {
      if (multiSelectActive) {
        clearMultiSelect();
        return;
      }
      setThread(null);
      setCursor(null);
    },
    selectAll: (event) => {
      event.preventDefault();
      selectAll(rowIds);
    },
    toggleStar: () => {
      const ids = multiSelectActive
        ? [...selectedIds]
        : cursor === null
          ? []
          : ([rows[cursor]?.id].filter(Boolean) as string[]);
      if (!ids.length) return;
      const starred = rows.some((row) => ids.includes(row.id) && row.starred);
      onTriage?.(ids, {
        kind: 'label',
        add: starred ? [] : ['STARRED'],
        remove: starred ? ['STARRED'] : [],
      });
    },
    markRead: () =>
      onTriage?.(
        multiSelectActive
          ? [...selectedIds]
          : cursor === null
            ? []
            : ([rows[cursor]?.id].filter(Boolean) as string[]),
        { kind: 'label', add: [], remove: ['UNREAD'] },
      ),
    markUnread: () =>
      onTriage?.(
        multiSelectActive
          ? [...selectedIds]
          : cursor === null
            ? []
            : ([rows[cursor]?.id].filter(Boolean) as string[]),
        { kind: 'label', add: ['UNREAD'], remove: [] },
      ),
    markSpam: () =>
      onTriage?.(
        multiSelectActive
          ? [...selectedIds]
          : cursor === null
            ? []
            : ([rows[cursor]?.id].filter(Boolean) as string[]),
        { kind: 'move', destination: 'SPAM' },
      ),
    markNotSpam: () =>
      onTriage?.(
        multiSelectActive
          ? [...selectedIds]
          : cursor === null
            ? []
            : ([rows[cursor]?.id].filter(Boolean) as string[]),
        { kind: 'move', destination: 'INBOX' },
      ),
    deleteConversation: () =>
      onTriage?.(
        multiSelectActive
          ? [...selectedIds]
          : cursor === null
            ? []
            : ([rows[cursor]?.id].filter(Boolean) as string[]),
        { kind: 'delete' },
      ),
  });
  useEffect(() => {
    pruneSelected(rowIds);
  }, [rowIds, pruneSelected]);
  const handleRowClick = useCallback(
    (event: ReactMouseEvent, index: number) => {
      const row = rows[index];
      if (!row) return;
      const activeId = cursor === null ? undefined : rows[cursor]?.id;
      if ((event.shiftKey || event.metaKey || event.ctrlKey) && !multiSelectActive && activeId)
        toggleSelected(activeId);
      if (event.shiftKey) {
        selectRange(rowIds, row.id);
        return;
      }
      if (event.metaKey || event.ctrlKey) {
        toggleSelected(row.id);
        return;
      }
      open(index);
    },
    [cursor, multiSelectActive, rows, rowIds, selectRange, toggleSelected, open],
  );
  const incompleteStrip = searchActive && searchIncomplete && (
    <div
      role="status"
      data-testid="search-incomplete-notice"
      className="mb-1 flex items-center gap-2 rounded bg-badge-draft px-3 py-2 text-label-sm text-badge-on-draft dark:bg-dark-badge-draft dark:text-dark-badge-on-draft"
    >
      <Info aria-hidden="true" size={14} />
      Results may be incomplete — mail is still syncing.
    </div>
  );
  const content = (() => {
    if (state === 'loading') return <LoadingState>Loading conversations…</LoadingState>;
    if (state === 'empty')
      return <EmptyState>{emptyCopy[mailboxId] ?? 'No conversations in this mailbox.'}</EmptyState>;
    if (state === 'searchEmpty')
      return (
        <>
          {incompleteStrip}
          <EmptyState variant="search" query={searchQueryText ?? ''} />
        </>
      );
    if (state === 'syncing')
      return (
        <EmptyState
          variant="syncing"
          persistedCount={syncProgress?.persistedCount}
          discoveredCount={syncProgress?.discoveredCount}
        >
          Older mail is still arriving
        </EmptyState>
      );
    if (state === 'error')
      return (
        <ErrorState>
          Couldn’t load conversations.{' '}
          <button
            onClick={onRetry}
            className="cursor-pointer underline focus-visible:outline-2 focus-visible:outline-primary"
          >
            Retry
          </button>
          {errorMessage && <span className="block text-body-sm">{errorMessage}</span>}
        </ErrorState>
      );
    const items = virtualizer.getVirtualItems();
    const visible = items.length
      ? items
      : rows.map((_, index) => ({ key: index, index, start: index * rowHeight }));
    return (
      <>
        {incompleteStrip}
        <div style={{ height: `${virtualizer.getTotalSize()}px` }} className="relative">
          {visible.map((item) => (
            <div
              key={item.key}
              data-index={item.index}
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <ConversationRow
                conversation={rows[item.index]}
                density={density}
                active={cursor === item.index}
                selected={selectedIds.has(rows[item.index].id)}
                flash={flashThreadId === rows[item.index].id}
                onFlashComplete={() => useSelectionStore.getState().setFlashThreadId(null)}
                multiSelectActive={multiSelectActive}
                allLabels={allLabels}
                selectionCount={selectedIds.size}
                selectionSystemLabelIds={selectionSystemLabelIds}
                currentFolderId={currentFolderId}
                onOpen={(event) => handleRowClick(event, item.index)}
                onStar={() => {
                  const row = rows[item.index];
                  const ids =
                    selectedIds.has(row.id) && multiSelectActive ? [...selectedIds] : [row.id];
                  const starred = rows.some(
                    (candidate) => ids.includes(candidate.id) && candidate.starred,
                  );
                  onTriage?.(ids, {
                    kind: 'label',
                    add: starred ? [] : ['STARRED'],
                    remove: starred ? ['STARRED'] : [],
                  });
                }}
                onTriage={(intent) => {
                  const ids =
                    selectedIds.has(rows[item.index].id) && multiSelectActive
                      ? [...selectedIds]
                      : [rows[item.index].id];
                  onTriage?.(ids, intent);
                }}
                onCompose={
                  !multiSelectActive && rows[item.index].id === composeTargetThreadId
                    ? (action) => onCompose?.(rows[item.index].id, action)
                    : undefined
                }
              />
            </div>
          ))}
        </div>
        <p className="p-stack-gap-sm text-center text-label-sm text-secondary dark:text-dark-secondary">
          {pages && fixturePage < pages.length - 1
            ? 'Loading more conversations…'
            : 'End of conversations'}
        </p>
      </>
    );
  })();
  const loadNextPage = () => {
    if (!pages || fixturePage >= pages.length - 1) return;
    setFixturePage((current) => current + 1);
  };
  return (
    <div
      ref={parentRef}
      data-testid="conversation-list"
      className="min-h-0 flex-1 overflow-auto p-stack-gap-sm"
      onScroll={() => {
        if (parentRef.current && parentRef.current.scrollTop <= rowHeight) onLoadPrevious?.();
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

export function ConversationListContainer() {
  const accountId = useSelectionStore((value) => value.activeAccountId);
  const activeThreadId = useSelectionStore((value) => value.activeThreadId);
  const mailboxId = useSelectionStore((value) => value.activeMailboxId) ?? 'INBOX';
  const searchActive = useSearchStore((value) => value.active);
  const searchQuery = useSearchStore((value) => value.submittedQuery);
  const searchScope = useSearchStore((value) => value.scope);
  const query = useThreadsQuery(accountId, mailboxId);
  const searchResultsQuery = useSearchThreadsQuery(accountId, searchQuery, searchScope);
  const activeQuery = searchActive ? searchResultsQuery : query;
  const traversal = useTraversalStatusQuery(accountId);
  const triage = useThreadTriageIntentMutation(accountId);
  const labelsQuery = useLabelsQuery(accountId);
  const accountsQuery = useAccountsQuery();
  const activeConversation = useConversationQuery(accountId, activeThreadId);
  const accountEmail = accountsQuery.data?.find((account) => account.id === accountId)?.email ?? '';
  const allLabels = useMemo<LabelMenuEntry[]>(
    () =>
      mapLabelsToUserLabels(labelsQuery.data ?? []).map((label) => ({
        ...label,
        membership: 'unchecked',
      })),
    [labelsQuery.data],
  );
  const rows = useMemo(
    () =>
      (activeQuery.data?.pages ?? []).flatMap((page) =>
        page.items.map((thread) => mapThreadToRow(thread)),
      ),
    [activeQuery.data],
  );
  const backfillIncomplete =
    traversal.data?.state === 'backfilling' || traversal.data?.state === 'reconciling';
  const forcedState = fixtureState();
  const state: ListState =
    forcedState !== 'ready'
      ? forcedState
      : activeQuery.isError
        ? 'error'
        : activeQuery.isPending
          ? 'loading'
          : rows.length === 0
            ? searchActive
              ? 'searchEmpty'
              : backfillIncomplete
                ? 'syncing'
                : 'empty'
            : 'ready';
  return (
    <ConversationList
      threads={rows}
      state={state}
      searchQueryText={searchActive ? searchQuery : undefined}
      searchIncomplete={backfillIncomplete}
      errorMessage={activeQuery.error ? activeQuery.error.message : undefined}
      onRetry={() => void activeQuery.refetch()}
      onLoadMore={() => {
        if (activeQuery.hasNextPage && !activeQuery.isFetchingNextPage)
          void activeQuery.fetchNextPage();
      }}
      onLoadPrevious={() => {
        if (activeQuery.hasPreviousPage && !activeQuery.isFetchingPreviousPage)
          void activeQuery.fetchPreviousPage();
      }}
      allLabels={allLabels}
      onTriage={(threadIds, intent) => {
        triage.mutate(threadIds, intent);
      }}
      onCompose={(targetThreadId, action) => {
        if (!accountId || targetThreadId !== activeThreadId || !activeConversation.data) return;
        const conversation = mapConversation(activeConversation.data);
        const message = conversation.messages.at(-1);
        if (action === 'reply') void openReply('reply', accountId, accountEmail, message);
        else if (action === 'reply-all')
          void openReply('reply-all', accountId, accountEmail, message);
        else if (action === 'forward') void openForward(accountId, accountEmail, message);
        else void openEditDraft(accountId, accountEmail, conversation.subject, message);
      }}
      composeTargetThreadId={activeThreadId}
      syncProgress={
        traversal.data
          ? {
              persistedCount: traversal.data.persistedCount,
              discoveredCount: traversal.data.discoveredCount,
            }
          : undefined
      }
    />
  );
}
