import { toDate } from 'date-fns';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventBridge,
  MAILBOX_INVALIDATION_DEBOUNCE_MS,
  TRAVERSAL_INVALIDATION_DEBOUNCE_MS,
} from '@/lib/query/event-bridge';
import type { useThreadsQuery } from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { QueryProvider } from '@/providers/QueryProvider';
import { useSyncStore } from '@/stores/sync';
import { ipc } from '@/tests/ipc-mock';
import {
  RUST_COMPLETED_AT,
  SpyClient,
  ThreadQuery,
  captureQueryClient,
  resetEventBridgeSyncStore,
} from '@/tests/lib/query/event-bridge-helpers';

const REFETCHES_AFTER_NEW_MAIL = 2;
const TRAVERSAL_EVENT_BURST = 100;
const LAST_TRAVERSAL_COUNT = TRAVERSAL_EVENT_BURST - 1;
const INVALIDATIONS_PER_TRAVERSAL_FLUSH = 2;
const RETAINED_EXTRA_PAGES = 4;
const RETAINED_PAGE_FETCHES = RETAINED_EXTRA_PAGES + 1;

describe('EventBridge sync and traversal', () => {
  beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => undefined));

  afterEach(() => {
    vi.useRealTimers();
    resetEventBridgeSyncStore();
  });

  it('updates sync state live from sync progress and completion events', async () => {
    render(
      <QueryProvider>
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://progress', expect.any(Function)),
    );
    act(() => ipc.emit('sync://progress', { accountId: 'account-1', state: 'syncing' }));
    expect(useSyncStore.getState().syncState).toBe('syncing');
    act(() =>
      ipc.emit('sync://complete', {
        accountId: 'account-1',
        historyId: 42,
        addedCount: 3,
        changed: true,
        completedAt: RUST_COMPLETED_AT,
      }),
    );
    expect(useSyncStore.getState().syncState).toBe('idle');
    expect(useSyncStore.getState().lastSynced).toBeInstanceOf(Date);
  });

  it('updates lastSynced on an unchanged tick and invalidates only sync status', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://complete', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() =>
      ipc.emit('sync://complete', {
        accountId: 'account-1',
        historyId: 42,
        addedCount: 0,
        changed: false,
        completedAt: RUST_COMPLETED_AT,
      }),
    );
    expect(useSyncStore.getState().syncState).toBe('idle');
    expect(useSyncStore.getState().lastSynced).toEqual(toDate(RUST_COMPLETED_AT));
    expect(useSyncStore.getState().error).toBeUndefined();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.syncStatus('account-1'),
    });
  });

  it('coalesces completion and new-mail invalidations for one account', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://complete', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    vi.useFakeTimers();
    act(() => {
      ipc.emit('sync://complete', {
        accountId: 'account-1',
        historyId: 42,
        addedCount: 3,
        changed: true,
        completedAt: RUST_COMPLETED_AT,
      });
      ipc.emit('mail://new', { accountId: 'account-1', threadIds: ['thread-1'], arrivals: [] });
      vi.advanceTimersByTime(MAILBOX_INVALIDATION_DEBOUNCE_MS);
    });
    for (const queryKey of [
      queryKeys.threadsForAccount('account-1'),
      queryKeys.searchForAccount('account-1'),
      queryKeys.searchTotalsForAccount('account-1'),
      queryKeys.labels('account-1'),
      queryKeys.syncStatus('account-1'),
    ]) {
      expect(
        invalidate.mock.calls.filter(
          ([argument]) => JSON.stringify(argument?.queryKey) === JSON.stringify(queryKey),
        ),
      ).toHaveLength(1);
    }
    vi.useRealTimers();
  });

  it('invalidates mailbox data for new mail without a completion event', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('mail://new', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    vi.useFakeTimers();
    act(() => {
      ipc.emit('mail://new', { accountId: 'account-1', threadIds: ['thread-1'], arrivals: [] });
      vi.advanceTimersByTime(MAILBOX_INVALIDATION_DEBOUNCE_MS);
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.threadsForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
    vi.useRealTimers();
  });

  it('refetches the mounted mailbox list when new mail arrives', async () => {
    let query: ReturnType<typeof useThreadsQuery> | undefined;
    let calls = 0;
    ipc.override('list_threads', () => {
      calls += 1;
      return { items: [], nextCursor: null, previousCursor: null };
    });
    render(
      <QueryProvider>
        <ThreadQuery onReady={(readyQuery) => (query = readyQuery)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() => expect(query?.isSuccess).toBe(true));
    expect(calls).toBe(1);
    act(() => {
      ipc.emit('mail://new', { accountId: 'account-1', threadIds: ['thread-new'], arrivals: [] });
    });
    await waitFor(() => expect(calls).toBe(REFETCHES_AFTER_NEW_MAIL));
  });

  it('coalesces a large traversal into one bounded invalidation burst', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://traversal', expect.any(Function)),
    );
    vi.useFakeTimers();
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() => {
      for (let count = 0; count < TRAVERSAL_EVENT_BURST; count += 1)
        ipc.emit('sync://traversal', {
          accountId: 'account-1',
          kind: 'backfill',
          discoveredCount: count,
          persistedCount: count,
          completed: false,
          state: 'backfilling',
          lastAdvancedAt: 1,
          isResumed: false,
        });
      vi.advanceTimersByTime(TRAVERSAL_INVALIDATION_DEBOUNCE_MS);
    });
    expect(invalidate).toHaveBeenCalledTimes(INVALIDATIONS_PER_TRAVERSAL_FLUSH);
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
    expect(clientCapture.client().getQueryData(queryKeys.traversalStatus('account-1'))).toEqual({
      accountId: 'account-1',
      state: 'backfilling',
      kind: 'backfill',
      discoveredCount: LAST_TRAVERSAL_COUNT,
      persistedCount: LAST_TRAVERSAL_COUNT,
      lastAdvancedAt: 1,
      isResumed: false,
    });
    vi.useRealTimers();
  });

  it('marks retained mailbox pages stale without refetching them after traversal events', async () => {
    let query: ReturnType<typeof useThreadsQuery> | undefined;
    let calls = 0;
    ipc.override('list_threads', ({ cursor }) => {
      calls += 1;
      const page = cursor?.latestAt ?? 0;
      return {
        items: [],
        nextCursor:
          page < RETAINED_EXTRA_PAGES ? { latestAt: page + 1, id: String(page + 1) } : null,
        previousCursor: page > 0 ? { latestAt: page - 1, id: String(page - 1) } : null,
      };
    });
    render(
      <QueryProvider>
        <ThreadQuery onReady={(readyQuery) => (query = readyQuery)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() => expect(query?.isSuccess).toBe(true));
    for (let page = 0; page < RETAINED_EXTRA_PAGES; page += 1)
      await act(async () => {
        await query?.fetchNextPage();
      });
    expect(calls).toBe(RETAINED_PAGE_FETCHES);
    vi.useFakeTimers();
    act(() => {
      ipc.emit('sync://traversal', {
        accountId: 'account-1',
        kind: 'backfill',
        discoveredCount: 5,
        persistedCount: 5,
        completed: false,
        state: 'backfilling',
        lastAdvancedAt: 1,
        isResumed: false,
      });
      vi.advanceTimersByTime(TRAVERSAL_INVALIDATION_DEBOUNCE_MS);
    });
    expect(calls).toBe(RETAINED_PAGE_FETCHES);
    vi.useRealTimers();
  });

  it('tears down every listener and any pending traversal timer on unmount', async () => {
    const { unmount } = render(
      <QueryProvider>
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://traversal', expect.any(Function)),
    );
    vi.useFakeTimers();

    act(() =>
      ipc.emit('sync://traversal', {
        accountId: 'account-1',
        kind: 'backfill',
        discoveredCount: 1,
        persistedCount: 1,
        completed: false,
        state: 'backfilling',
        lastAdvancedAt: 1,
        isResumed: false,
      }),
    );
    const clearSpy = vi.spyOn(window, 'clearTimeout');
    act(() => unmount());
    expect(clearSpy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
