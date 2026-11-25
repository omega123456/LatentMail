import { act, render } from '@testing-library/react';
import type React from 'react';
import { getTime, parseISO } from 'date-fns';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ipc } from '@/tests/ipc-mock';
import { useSyncStore } from '@/stores/sync';

export const emptyQueue = {
  pending: 0,
  active: 0,
  failed: 0,
  done: 0,
  paused: false,
  suspended: false,
};

export function renderStatusBar(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

export function setStatus(
  state: 'idle' | 'syncing' | 'error',
  queue = emptyQueue,
  lastSynced: Date | null = parseISO('2026-08-11T10:00:00Z'),
) {
  act(() =>
    useSyncStore.setState({
      queue: queue,
      syncState: state,
      lastSynced: lastSynced,
      error: state === 'error' ? 'Gmail is unavailable' : undefined,
      refreshing: false,
    }),
  );
}

export function overrideTraversal(
  state: 'backfilling' | 'reconciling',
  isResumed = false,
  counts = { discoveredCount: 50000, persistedCount: 12400 },
) {
  ipc.override('read_traversal_status', {
    accountId: 'account-1',
    state: state,
    kind: state === 'backfilling' ? 'backfill' : null,
    lastAdvancedAt: getTime(parseISO('2026-08-11T10:00:00Z')),
    isResumed: isResumed,
    ...counts,
  });
}

export function resetStatusBarSyncStore() {
  act(() => useSyncStore.setState({ queue: emptyQueue, refreshing: false }));
}
