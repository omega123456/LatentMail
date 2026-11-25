import { useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react';
import type { Virtualizer } from '@tanstack/react-virtual';
import { useMailVirtualizer } from '@/lib/react-virtual';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import {
  useAccountsQuery,
  useConversationQuery,
  useLabelsQuery,
  useSearchThreadsQuery,
  useThreadsQuery,
  useTraversalStatusQuery,
} from '@/lib/query/hooks';
import { useThreadTriageIntentMutation, type ThreadTriageIntent } from '@/lib/query/mutations';
import { mapConversation, mapLabelsToUserLabels, mapThreadToRow } from '@/lib/query/mappers';
import { openComposeAction, type ComposeAction } from '@/lib/compose/entry';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import type { Conversation } from '@/lib/types/conversation';
import { conversationFixtures } from './conversation-fixtures';
import {
  isBackfillIncomplete,
  ListStatusContent,
  resolveContainerSyncProgress,
  resolveListState,
  ROW_HEIGHT_BY_DENSITY,
  type ListState,
} from './conversation-list-status';
import {
  useConversationListCommands,
  useConversationListPagination,
  useRowInteraction,
  useScrollSynchronization,
} from './useConversationListBehavior';
import { VirtualizedConversationRows } from './VirtualizedConversationRows';

const VIRTUALIZER_OVERSCAN = 5;

type ConversationListProps = {
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
  onCompose?: (threadId: string, action: ComposeAction) => void;
  composeTargetThreadId?: string | null;
  searchQueryText?: string;
  searchIncomplete?: boolean;
};

function handleListScrollEdge(input: {
  container: HTMLDivElement | null;
  rowHeight: number;
  onLoadPrevious?: () => void;
  loadNextPage: () => void;
  onLoadMore?: () => void;
}) {
  if (!input.container) return;
  if (input.container.scrollTop <= input.rowHeight) input.onLoadPrevious?.();
  const nearBottom =
    input.container.scrollTop + input.container.clientHeight >=
    input.container.scrollHeight - input.rowHeight;
  if (!nearBottom) return;
  input.loadNextPage();
  input.onLoadMore?.();
}

function ConversationListContent({
  props,
  state,
  mailboxId,
  searchActive,
  rows,
  rowHeight,
  virtualizer,
  hasMoreFixturePages,
  onRowClick,
}: {
  props: ConversationListProps;
  state: ListState;
  mailboxId: string;
  searchActive: boolean;
  rows: Conversation[];
  rowHeight: number;
  virtualizer: Virtualizer<HTMLDivElement, Element>;
  hasMoreFixturePages: boolean;
  onRowClick: (event: ReactMouseEvent, index: number) => void;
}) {
  'use no memo';
  const showIncompleteNotice = searchActive && Boolean(props.searchIncomplete);
  if (state !== 'ready') {
    return (
      <ListStatusContent
        state={state}
        mailboxId={mailboxId}
        showIncompleteNotice={showIncompleteNotice}
        searchQueryText={props.searchQueryText}
        syncProgress={props.syncProgress}
        errorMessage={props.errorMessage}
        onRetry={props.onRetry}
      />
    );
  }
  return (
    <VirtualizedConversationRows
      rows={rows}
      rowHeight={rowHeight}
      virtualizer={virtualizer}
      showIncompleteNotice={showIncompleteNotice}
      hasMoreFixturePages={hasMoreFixturePages}
      allLabels={props.allLabels ?? []}
      currentFolderId={searchActive ? undefined : mailboxId}
      composeTargetThreadId={props.composeTargetThreadId}
      onRowClick={onRowClick}
      onTriage={props.onTriage}
      onCompose={props.onCompose}
    />
  );
}

function useConversationVirtualizer(
  parentRef: React.RefObject<HTMLDivElement | null>,
  count: number,
  rowHeight: number,
) {
  'use no memo';
  return useMailVirtualizer({
    count: count,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: VIRTUALIZER_OVERSCAN,
  });
}

export function ConversationList(props: ConversationListProps) {
  'use no memo';
  const parentRef = useRef<HTMLDivElement>(null);
  const density = useLayoutStore((layout) => layout.density);
  const mailboxId = useSelectionStore((selection) => selection.activeMailboxId) ?? 'INBOX';
  const searchActive = useSearchStore((search) => search.active);
  const { rows, fixturePage, loadNextPage } = useConversationListPagination(
    props.pages,
    props.threads ?? conversationFixtures,
    mailboxId,
  );
  const rowHeight = ROW_HEIGHT_BY_DENSITY[density];
  const virtualizer = useConversationVirtualizer(parentRef, rows.length, rowHeight);
  const rowIds = useMemo(() => rows.map((row) => row.id), [rows]);
  const { openRow, handleRowClick } = useRowInteraction({
    rows: rows,
    rowIds: rowIds,
    onTriage: props.onTriage,
  });
  useScrollSynchronization({ parentRef, rows, density, mailboxId, searchActive, virtualizer });
  useConversationListCommands({
    rows: rows,
    rowIds: rowIds,
    rowHeight: rowHeight,
    parentRef: parentRef,
    virtualizer: virtualizer,
    openRow: openRow,
    onTriage: props.onTriage,
  });

  return (
    <div
      ref={parentRef}
      data-testid="conversation-list"
      className="min-h-0 flex-1 overflow-auto p-stack-gap-sm"
      onScroll={() =>
        handleListScrollEdge({
          container: parentRef.current,
          rowHeight: rowHeight,
          onLoadPrevious: props.onLoadPrevious,
          loadNextPage: loadNextPage,
          onLoadMore: props.onLoadMore,
        })
      }
    >
      <ConversationListContent
        props={props}
        state={props.state ?? 'ready'}
        mailboxId={mailboxId}
        searchActive={searchActive}
        rows={rows}
        rowHeight={rowHeight}
        virtualizer={virtualizer}
        hasMoreFixturePages={Boolean(props.pages && fixturePage < props.pages.length - 1)}
        onRowClick={handleRowClick}
      />
    </div>
  );
}

function useConversationListContainerData() {
  const accountId = useSelectionStore((selection) => selection.activeAccountId);
  const activeThreadId = useSelectionStore((selection) => selection.activeThreadId);
  const mailboxId = useSelectionStore((selection) => selection.activeMailboxId) ?? 'INBOX';
  const searchActive = useSearchStore((search) => search.active);
  const searchQuery = useSearchStore((search) => search.submittedQuery);
  const searchScope = useSearchStore((search) => search.scope);
  const query = useThreadsQuery(accountId, mailboxId);
  const searchResultsQuery = useSearchThreadsQuery(accountId, searchQuery, searchScope);
  const activeQuery = searchActive ? searchResultsQuery : query;
  const traversal = useTraversalStatusQuery(accountId);
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
  const backfillIncomplete = isBackfillIncomplete(traversal.data?.state);
  const state = resolveListState({
    isError: activeQuery.isError,
    isPending: activeQuery.isPending,
    rowCount: rows.length,
    searchActive: searchActive,
    backfillIncomplete: backfillIncomplete,
  });
  return {
    accountId,
    activeThreadId,
    searchActive,
    searchQuery,
    activeQuery,
    traversal,
    activeConversation,
    accountEmail,
    allLabels,
    rows,
    backfillIncomplete,
    state,
  };
}

export function ConversationListContainer() {
  const data = useConversationListContainerData();
  const triage = useThreadTriageIntentMutation(data.accountId);

  const handleCompose = (targetThreadId: string, action: ComposeAction) => {
    if (
      !data.accountId ||
      targetThreadId !== data.activeThreadId ||
      !data.activeConversation.data
    ) {
      return;
    }
    const conversation = mapConversation(data.activeConversation.data);
    void openComposeAction({
      action: action,
      accountId: data.accountId,
      accountEmail: data.accountEmail,
      subject: conversation.subject,
      message: conversation.messages.at(-1),
    });
  };

  return (
    <ConversationList
      threads={data.rows}
      state={data.state}
      searchQueryText={data.searchActive ? data.searchQuery : undefined}
      searchIncomplete={data.backfillIncomplete}
      errorMessage={data.activeQuery.error?.message}
      onRetry={() => void data.activeQuery.refetch()}
      onLoadMore={() => {
        if (data.activeQuery.hasNextPage && !data.activeQuery.isFetchingNextPage) {
          void data.activeQuery.fetchNextPage();
        }
      }}
      onLoadPrevious={() => {
        if (data.activeQuery.hasPreviousPage && !data.activeQuery.isFetchingPreviousPage) {
          void data.activeQuery.fetchPreviousPage();
        }
      }}
      allLabels={data.allLabels}
      onTriage={(threadIds, intent) => triage.mutate(threadIds, intent)}
      onCompose={handleCompose}
      composeTargetThreadId={data.activeThreadId}
      syncProgress={resolveContainerSyncProgress(data.traversal.data)}
    />
  );
}
