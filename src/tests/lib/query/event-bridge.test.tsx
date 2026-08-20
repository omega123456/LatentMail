import { act, render, waitFor } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBridge } from '@/lib/query/event-bridge';
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

describe('EventBridge', () => {
  beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => undefined));

  afterEach(() =>
    act(() =>
      useSyncStore.setState({
        queue: { pending: 0, active: 0, failed: 0, done: 0, paused: false },
        syncState: 'idle',
        lastSynced: null,
      }),
    ),
  );

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
      ipc.emit('queue://summary', { pending: 3, active: 1, failed: 0, done: 0, paused: true }),
    );
    expect(useSyncStore.getState().queue).toMatchObject({ pending: 3, active: 1, paused: true });
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

  it('updates lastSynced on an unchanged tick without invalidating thread queries', async () => {
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
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('invalidates threads, labels and sync status when a tick reports changes', async () => {
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
        addedCount: 3,
        changed: true,
      }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.threadsForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.syncStatus('account-1') });
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

  it('invalidates threads and labels on mail://new so a new arrival refreshes the list', async () => {
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
    act(() =>
      ipc.emit('mail://new', { accountId: 'account-1', threadIds: ['thread-1'], arrivals: [] }),
    );
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.threadsForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
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
        });
      vi.advanceTimersByTime(250);
    });
    expect(invalidate).toHaveBeenCalledTimes(3);
    expect(invalidate).not.toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
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
      ipc.emit('queue://summary', { pending: 1, active: 1, failed: 0, done: 0, paused: false });
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.threadsForAccount('account-1') });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.searchForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
  });
});
