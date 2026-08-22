import { act, render, waitFor } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBridge } from '@/lib/query/event-bridge';
import { useThreadsQuery } from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { QueryProvider } from '@/providers/QueryProvider';
import { useSyncStore } from '@/stores/sync';
import { useComposeStore } from '@/stores/compose';
import { useToastStore } from '@/stores/toast';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';

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
      }),
    );
    expect(useSyncStore.getState().syncState).toBe('idle');
    expect(useSyncStore.getState().lastSynced).toBeInstanceOf(Date);
  });

  it('updates lastSynced on an unchanged tick and invalidates only sync status', async () => {
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://complete', expect.any(Function)),
    );
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
    act(() =>
      ipc.emit('sync://complete', {
        accountId: 'account-1',
        historyId: 42,
        addedCount: 0,
        changed: false,
      }),
    );
    expect(useSyncStore.getState().syncState).toBe('idle');
    expect(useSyncStore.getState().lastSynced).toBeInstanceOf(Date);
    expect(useSyncStore.getState().error).toBeUndefined();
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.syncStatus('account-1'),
    });
  });

  it('coalesces completion and new-mail invalidations for one account', async () => {
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://complete', expect.any(Function)),
    );
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
    vi.useFakeTimers();
    act(() => {
      ipc.emit('sync://complete', {
        accountId: 'account-1',
        historyId: 42,
        addedCount: 3,
        changed: true,
      });
      ipc.emit('mail://new', { accountId: 'account-1', threadIds: ['thread-1'], arrivals: [] });
      vi.advanceTimersByTime(250);
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
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('account://state', expect.any(Function)),
    );
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
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

  it('invalidates only the matching message-body family after a body fetch', async () => {
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('message://body-fetched', expect.any(Function)),
    );
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
    act(() =>
      ipc.emit('message://body-fetched', { accountId: 'account-1', messageId: 'message-1' }),
    );
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.messageBodiesForMessage('account-1', 'message-1'),
    });
  });

  it('invalidates exactly the matching sender-avatar query on resolution, and only that one', async () => {
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('avatar://resolved', expect.any(Function)),
    );
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
    act(() =>
      ipc.emit('avatar://resolved', { pipeline: 'sender', key: 'example.com', resolved: true }),
    );
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.senderAvatar('example.com'),
    });
  });

  it('invalidates exactly the matching account-avatar query on resolution', async () => {
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('avatar://resolved', expect.any(Function)),
    );
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
    act(() =>
      ipc.emit('avatar://resolved', { pipeline: 'account', key: 'account-1', resolved: false }),
    );
    expect(invalidate).toHaveBeenCalledExactlyOnceWith({
      queryKey: queryKeys.accountAvatar('account-1'),
    });
  });

  it('invalidates mailbox data for new mail without a completion event', async () => {
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('mail://new', expect.any(Function)),
    );
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
    vi.useFakeTimers();
    act(() => {
      ipc.emit('mail://new', { accountId: 'account-1', threadIds: ['thread-1'], arrivals: [] });
      vi.advanceTimersByTime(250);
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
        <ThreadQuery onReady={(value) => (query = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() => expect(query?.isSuccess).toBe(true));
    expect(calls).toBe(1);
    act(() => {
      ipc.emit('mail://new', { accountId: 'account-1', threadIds: ['thread-new'], arrivals: [] });
    });
    await waitFor(() => expect(calls).toBe(2));
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
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://traversal', expect.any(Function)),
    );
    vi.useFakeTimers();
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
    act(() => {
      for (let count = 0; count < 100; count += 1)
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
      vi.advanceTimersByTime(1000);
    });
    expect(invalidate).toHaveBeenCalledTimes(2);
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
    expect(client!.getQueryData(queryKeys.traversalStatus('account-1'))).toEqual({
      accountId: 'account-1',
      state: 'backfilling',
      kind: 'backfill',
      discoveredCount: 99,
      persistedCount: 99,
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
        nextCursor: page < 4 ? { latestAt: page + 1, id: String(page + 1) } : null,
        previousCursor: page > 0 ? { latestAt: page - 1, id: String(page - 1) } : null,
      };
    });
    render(
      <QueryProvider>
        <ThreadQuery onReady={(value) => (query = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() => expect(query?.isSuccess).toBe(true));
    for (let page = 0; page < 4; page += 1)
      await act(async () => {
        await query?.fetchNextPage();
      });
    expect(calls).toBe(5);
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
      vi.advanceTimersByTime(1000);
    });
    expect(calls).toBe(5);
    vi.useRealTimers();
  });

  it('coalesces a burst of queue item and summary events into one queue-snapshot invalidation', async () => {
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('queue://item', expect.any(Function)),
    );
    vi.useFakeTimers();
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
    act(() => {
      for (let count = 0; count < 20; count += 1)
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
      vi.advanceTimersByTime(250);
    });
    const queueSnapshotCalls = invalidate.mock.calls.filter(
      ([arg]) => JSON.stringify(arg?.queryKey) === JSON.stringify(queryKeys.queueOperations),
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
    let client: ReturnType<typeof useQueryClient> | undefined;
    render(
      <QueryProvider>
        <SpyClient onReady={(value) => (client = value)} />
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
    const invalidate = vi.spyOn(client!, 'invalidateQueries');
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
    act(() => vi.advanceTimersByTime(250));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.threadsForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
    vi.useRealTimers();
  });
});
