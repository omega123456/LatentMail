import { Info } from 'lucide-react';
import { EmptyState } from '@/components/states/EmptyState';
import { ErrorState } from '@/components/states/ErrorState';
import { LoadingState } from '@/components/states/LoadingState';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { intersectAll } from '@/lib/collections';
import type { Conversation } from '@/lib/types/conversation';
import type { Density } from '@/lib/types/ipc';

export const ROW_HEIGHT_BY_DENSITY: Record<Density, number> = {
  compact: 48,
  comfortable: 68,
  spacious: 88,
};

export type ListState = 'ready' | 'loading' | 'empty' | 'syncing' | 'error' | 'searchEmpty';

const EMPTY_COPY: Record<string, string> = {
  INBOX: 'Your Inbox is clear.',
  STARRED: 'No starred conversations.',
  SENT: 'No sent conversations.',
  TRASH: 'Trash is empty.',
};

export function intersectSystemLabelIds(conversations: Conversation[]): string[] {
  return intersectAll(conversations.map((conversation) => conversation.systemLabelIds ?? []));
}

export function isBackfillIncomplete(state: string | undefined): boolean {
  return state === 'backfilling' || state === 'reconciling';
}

export function resolveContainerSyncProgress(
  traversal: { persistedCount: number; discoveredCount: number } | undefined,
) {
  if (!traversal) return undefined;
  return {
    persistedCount: traversal.persistedCount,
    discoveredCount: traversal.discoveredCount,
  };
}

export function resolveListState(input: {
  isError: boolean;
  isPending: boolean;
  rowCount: number;
  searchActive: boolean;
  backfillIncomplete: boolean;
}): ListState {
  if (input.isError) return 'error';
  if (input.isPending) return 'loading';
  if (input.rowCount > 0) return 'ready';
  if (input.searchActive) return 'searchEmpty';
  return input.backfillIncomplete ? 'syncing' : 'empty';
}

export function SearchIncompleteNotice({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      role="status"
      data-testid="search-incomplete-notice"
      className="mb-1 flex items-center gap-2 rounded bg-badge-draft px-3 py-2 text-label-sm text-badge-on-draft dark:bg-dark-badge-draft dark:text-dark-badge-on-draft"
    >
      <Info aria-hidden="true" size={ICON_SIZE.sm} />
      Results may be incomplete — mail is still syncing.
    </div>
  );
}

export type ListStatusProps = {
  mailboxId: string;
  showIncompleteNotice: boolean;
  searchQueryText?: string;
  syncProgress?: { persistedCount: number; discoveredCount: number };
  errorMessage?: string;
  onRetry?: () => void;
};

const LIST_STATUS_VIEWS: Record<
  Exclude<ListState, 'ready'>,
  (props: ListStatusProps) => React.ReactNode
> = {
  loading: () => <LoadingState>Loading conversations…</LoadingState>,
  empty: ({ mailboxId }) => (
    <EmptyState>{EMPTY_COPY[mailboxId] ?? 'No conversations in this mailbox.'}</EmptyState>
  ),
  searchEmpty: ({ showIncompleteNotice, searchQueryText }) => (
    <>
      <SearchIncompleteNotice visible={showIncompleteNotice} />
      <EmptyState variant="search" query={searchQueryText ?? ''} />
    </>
  ),
  syncing: ({ syncProgress }) => (
    <EmptyState
      variant="syncing"
      persistedCount={syncProgress?.persistedCount}
      discoveredCount={syncProgress?.discoveredCount}
    >
      Older mail is still arriving
    </EmptyState>
  ),
  error: ({ errorMessage, onRetry }) => (
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
  ),
};

export function ListStatusContent({
  state,
  ...props
}: ListStatusProps & { state: Exclude<ListState, 'ready'> }) {
  return LIST_STATUS_VIEWS[state](props);
}
