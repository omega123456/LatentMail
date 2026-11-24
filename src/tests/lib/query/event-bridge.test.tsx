import { getTime, parseISO, toDate } from 'date-fns';
import { act, render, waitFor } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EventBridge,
  MAILBOX_INVALIDATION_DEBOUNCE_MS,
  QUEUE_SNAPSHOT_DEBOUNCE_MS,
  TRAVERSAL_INVALIDATION_DEBOUNCE_MS,
} from '@/lib/query/event-bridge';
import { useThreadsQuery } from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { QueryProvider } from '@/providers/QueryProvider';
import { useSyncStore } from '@/stores/sync';
import { useComposeStore } from '@/stores/compose';
import { useToastStore } from '@/stores/toast';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';
import { captureConsole } from '@/tests/console';

const RUST_COMPLETED_AT = getTime(parseISO('2026-08-11T10:00:00Z'));
const REFETCHES_AFTER_NEW_MAIL = 2;
const TRAVERSAL_EVENT_BURST = 100;
const LAST_TRAVERSAL_COUNT = TRAVERSAL_EVENT_BURST - 1;
const INVALIDATIONS_PER_TRAVERSAL_FLUSH = 2;
const RETAINED_EXTRA_PAGES = 4;
const RETAINED_PAGE_FETCHES = RETAINED_EXTRA_PAGES + 1;
const QUEUE_ITEM_BURST = 20;

type QueryClientHandle = ReturnType<typeof useQueryClient>;

function captureQueryClient() {
  let captured: QueryClientHandle | undefined;
  return {
    receive: (readyClient: QueryClientHandle) => {
      captured = readyClient;
    },
    client: (): QueryClientHandle => {
      if (!captured) throw new Error('query client was not captured');
      return captured;
    },
  };
}

function SpyClient({ onReady }: { onReady: (client: ReturnType<typeof useQueryClient>) => void }) {
  onReady(useQueryClient());
  return null;
}

function ThreadQuery({
  onReady,
}: {
  onReady: (query: ReturnType<typeof useThreadsQuery>) => void;
}) {
  onReady(useThreadsQuery('account-1', 'INBOX'));
  return null;
}

describe('EventBridge', () => {
  beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => undefined));

  afterEach(() => {
    vi.useRealTimers();
    act(() =>
      useSyncStore.setState({
        queue: { pending: 0, active: 0, failed: 0, done: 0, paused: false, suspended: false },
        syncState: 'idle',
        lastSynced: null,
      }),
    );
  });

  it('updates the queue store from queue summaries', async () => {
    render(
      <QueryProvider>
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('queue://summary', expect.any(Function)),
    );
    expect(ipc.tauriEmit).toHaveBeenCalledWith('frontend://ready', {});
    act(() =>
      ipc.emit('queue://summary', {
        pending: 3,
        active: 1,
        failed: 0,
        done: 0,
        paused: true,
        suspended: true,
      }),
    );
    expect(useSyncStore.getState().queue).toMatchObject({
      pending: 3,
      active: 1,
      paused: true,
      suspended: true,
    });
  });

  it('updates one index snapshot and removes only a deleted account snapshot', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('ai://index', expect.any(Function)),
    );
    clientCapture.client().setQueryData(queryKeys.aiIndexStatuses, [
      {
        accountId: 'account-1',
        state: 'building',
        indexed: 2,
        total: 10,
        indexedMessages: 2,
        totalEligibleMessages: 10,
        indexedPassages: 6,
        paused: false,
        error: null,
      },
      {
        accountId: 'account-2',
        state: 'building',
        indexed: 4,
        total: 10,
        indexedMessages: 4,
        totalEligibleMessages: 10,
        indexedPassages: 12,
        paused: false,
        error: null,
      },
    ]);
    act(() =>
      ipc.emit('ai://index', {
        accountId: 'account-1',
        indexed: 6,
        total: 10,
        indexedMessages: 6,
        totalEligibleMessages: 10,
        indexedPassages: 18,
        state: 'complete',
        paused: false,
        error: null,
      }),
    );
    expect(clientCapture.client().getQueryData(queryKeys.aiIndexStatuses)).toEqual([
      {
        accountId: 'account-1',
        state: 'complete',
        indexed: 6,
        total: 10,
        indexedMessages: 6,
        totalEligibleMessages: 10,
        indexedPassages: 18,
        paused: false,
        error: null,
      },
      {
        accountId: 'account-2',
        state: 'building',
        indexed: 4,
        total: 10,
        indexedMessages: 4,
        totalEligibleMessages: 10,
        indexedPassages: 12,
        paused: false,
        error: null,
      },
    ]);
    act(() => ipc.emit('ai://config', { accountId: 'account-1', removed: true }));
    expect(clientCapture.client().getQueryData(queryKeys.aiIndexStatuses)).toEqual([
      {
        accountId: 'account-2',
        state: 'building',
        indexed: 4,
        total: 10,
        indexedMessages: 4,
        totalEligibleMessages: 10,
        indexedPassages: 12,
        paused: false,
        error: null,
      },
    ]);
    clientCapture.client().setQueryData(queryKeys.aiIndexStatuses, []);
    act(() =>
      ipc.emit('ai://index', {
        accountId: 'account-3',
        indexed: 1,
        total: 2,
        indexedMessages: 1,
        totalEligibleMessages: 2,
        indexedPassages: 3,
        state: 'partial',
        paused: false,
        error: null,
      }),
    );
    expect(clientCapture.client().getQueryData(queryKeys.aiIndexStatuses)).toEqual([
      {
        accountId: 'account-3',
        indexed: 1,
        total: 2,
        indexedMessages: 1,
        totalEligibleMessages: 2,
        indexedPassages: 3,
        state: 'partial',
        paused: false,
        error: null,
      },
    ]);
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

  it('invalidates the accounts query on account state changes, so the reauth banner appears live', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('account://state', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() =>
      ipc.emit('account://state', {
        id: 'account-1',
        email: 'a@example.com',
        displayName: 'A',
        avatarUrl: null,
        needsReauthentication: true,
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.accounts });
  });

  it('invalidates the accounts query when Rust announces a removed account', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('account://removed', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() => ipc.emit('account://removed', { accountId: 'account-1' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.accounts });
  });

  it('re-reads every mail view of the account at once when Rust announces a local mail change', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('mail://changed', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() => ipc.emit('mail://changed', { accountId: 'account-1' }));
    expect(invalidate.mock.calls.map(([filters]) => filters)).toEqual([
      { queryKey: queryKeys.threadsForAccount('account-1') },
      { queryKey: queryKeys.conversationsForAccount('account-1') },
      { queryKey: queryKeys.searchForAccount('account-1') },
      { queryKey: queryKeys.searchTotalsForAccount('account-1') },
      { queryKey: queryKeys.labels('account-1') },
    ]);
  });

  it('invalidates only the matching message-body family after a body fetch', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('message://body-fetched', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() =>
      ipc.emit('message://body-fetched', { accountId: 'account-1', messageId: 'message-1' }),
    );
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.messageBodiesForMessage('account-1', 'message-1'),
    });
  });

  it('invalidates exactly the matching sender-avatar query on resolution, and only that one', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('avatar://resolved', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() =>
      ipc.emit('avatar://resolved', { pipeline: 'sender', key: 'example.com', resolved: true }),
    );
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.senderAvatar('example.com'),
    });
  });

  it('invalidates exactly the matching account-avatar query on resolution', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('avatar://resolved', expect.any(Function)),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() =>
      ipc.emit('avatar://resolved', { pipeline: 'account', key: 'account-1', resolved: false }),
    );
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.accountAvatar('account-1'),
    });
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

  it('handles an OS folder intent in the event bridge', async () => {
    render(
      <QueryProvider>
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('os://intent', expect.any(Function)),
    );
    act(() => ipc.emit('os://intent', { kind: 'openFolder', accountId: 'account-1' }));
    await waitFor(() => expect(useSelectionStore.getState().activeMailboxId).toBe('INBOX'));
    expect(useLayoutStore.getState().route).toBe('mail');
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

  it('refreshes the mailbox of the account named in a finished mutation event payload', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('queue://item', expect.any(Function)),
    );
    vi.useFakeTimers();
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() => {
      ipc.emit('queue://item', {
        id: 'mutation:operation-7',
        status: 'done',
        accountId: 'account-2',
        lane: 'interactive',
      });
      vi.advanceTimersByTime(MAILBOX_INVALIDATION_DEBOUNCE_MS);
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.threadsForAccount('account-2'),
    });
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: queryKeys.threadsForAccount('operation-7'),
    });
    vi.useRealTimers();
  });

  it('coalesces a burst of queue item and summary events into one queue-snapshot invalidation', async () => {
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('queue://item', expect.any(Function)),
    );
    vi.useFakeTimers();
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() => {
      for (let count = 0; count < QUEUE_ITEM_BURST; count += 1)
        ipc.emit('queue://item', {
          id: `queue:account-1:${count}`,
          status: 'active',
          accountId: 'account-1',
          lane: 'interactive',
        });
      ipc.emit('queue://summary', {
        pending: 1,
        active: 1,
        failed: 0,
        done: 0,
        paused: false,
        suspended: false,
      });
      vi.advanceTimersByTime(QUEUE_SNAPSHOT_DEBOUNCE_MS);
    });
    const queueSnapshotCalls = invalidate.mock.calls.filter(
      ([invalidation]) =>
        JSON.stringify(invalidation?.queryKey) === JSON.stringify(queryKeys.queueOperations),
    );
    expect(queueSnapshotCalls).toHaveLength(1);
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

  it('handles compose delivery events and ignores unrelated queue items through the shared IPC harness', async () => {
    const consoleError = captureConsole('error');
    const clientCapture = captureQueryClient();
    render(
      <QueryProvider>
        <SpyClient onReady={clientCapture.receive} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('draft://saved', expect.any(Function)),
    );
    act(() =>
      useComposeStore.getState().open({
        id: 'session-1',
        mode: 'new',
        accountId: 'account-1',
        from: 'me@example.com',
        recipients: { to: [], cc: [], bcc: [] },
        subject: 'Draft',
        html: '',
      }),
    );
    const invalidate = vi.spyOn(clientCapture.client(), 'invalidateQueries');
    act(() =>
      ipc.emit('draft://saved', {
        accountId: 'account-1',
        sessionId: 'session-1',
        draftId: 'draft-1',
      }),
    );
    expect(useComposeStore.getState().session).toMatchObject({ draftId: 'draft-1', dirty: false });
    act(() => ipc.emit('send://uncertain', { accountId: 'account-1' }));
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe(
      'Send status unknown — check Sent and Drafts.',
    );
    act(() =>
      ipc.emit('send://complete', {
        accountId: 'account-1',
        sessionId: 'session-1',
        draftId: 'draft-1',
      }),
    );
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Message sent.');

    act(() =>
      ipc.emit('compose://failed', {
        accountId: 'account-1',
        sessionId: 'session-1',
        kind: 'draft',
        error: 'Gmail request failed with status 400',
      }),
    );
    expect(useComposeStore.getState().session).toMatchObject({
      draftStatus: 'failed',
      lifecycleError: 'Couldn’t save draft.',
    });
    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Message sent.');

    act(() => useComposeStore.getState().close());
    act(() =>
      ipc.emit('compose://failed', {
        accountId: 'account-1',
        sessionId: 'session-1',
        kind: 'send',
        error: 'Gmail request failed with status 400',
      }),
    );

    expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Couldn’t send your message.');
    const beforeUnrelatedItem = invalidate.mock.calls.length;
    vi.useFakeTimers();
    act(() =>
      ipc.emit('queue://item', {
        id: 'queue:account-1:1',
        status: 'done',
        accountId: 'account-1',
        lane: 'background',
      }),
    );
    expect(invalidate).toHaveBeenCalledTimes(beforeUnrelatedItem);

    act(() =>
      ipc.emit('queue://item', {
        id: 'mutation:account-1:1',
        status: 'queued',
        accountId: 'account-1',
        lane: 'interactive',
      }),
    );
    act(() =>
      ipc.emit('queue://item', {
        id: 'mutation:account-1:1',
        status: 'active',
        accountId: 'account-1',
        lane: 'interactive',
      }),
    );
    expect(invalidate).toHaveBeenCalledTimes(beforeUnrelatedItem);
    act(() =>
      ipc.emit('queue://item', {
        id: 'mutation:account-1:1',
        status: 'done',
        accountId: 'account-1',
        lane: 'interactive',
      }),
    );
    act(() => vi.advanceTimersByTime(MAILBOX_INVALIDATION_DEBOUNCE_MS));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.threadsForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
    vi.useRealTimers();
    expect(consoleError).toHaveBeenCalledWith(
      'compose send failed: Gmail request failed with status 400',
    );
  });
});
