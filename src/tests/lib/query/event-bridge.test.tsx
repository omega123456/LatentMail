import { act, render, waitFor } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBridge } from '@/lib/query/event-bridge';
import { queryKeys } from '@/lib/query/keys';
import { QueryProvider } from '@/providers/QueryProvider';
import { useSyncStore } from '@/stores/sync';
import { useComposeStore } from '@/stores/compose';
import { useToastStore } from '@/stores/toast';
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
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
    expect(window.__notifications__).toEqual([]);
  });

  it('raises one OS notification naming the sender and subject of a new arrival', async () => {
    render(
      <QueryProvider>
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('mail://new', expect.any(Function)),
    );
    act(() =>
      ipc.emit('mail://new', {
        accountId: 'account-1',
        threadIds: ['thread-1'],
        arrivals: [{ sender: 'Alex Morgan <alex@example.com>', subject: 'Lunch?' }],
      }),
    );
    await waitFor(() =>
      expect(window.__notifications__).toEqual([{ title: 'Alex Morgan', body: 'Lunch?' }]),
    );
  });

  it('summarizes a multi-message poll and falls back for a missing subject', async () => {
    render(
      <QueryProvider>
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('mail://new', expect.any(Function)),
    );
    act(() =>
      ipc.emit('mail://new', {
        accountId: 'account-1',
        threadIds: ['thread-1'],
        arrivals: [
          { sender: 'ops@example.com', subject: '' },
          { sender: 'b@example.com', subject: 'Second' },
          { sender: 'c@example.com', subject: 'Third' },
        ],
      }),
    );
    await waitFor(() =>
      expect(window.__notifications__).toEqual([
        { title: 'ops@example.com', body: '(No subject) — and 2 more' },
      ]),
    );
  });

  it('asks for permission when it is not already granted, and stays quiet if refused', async () => {
    (Notification as { permission: NotificationPermission }).permission = 'denied';
    vi.mocked(Notification.requestPermission).mockResolvedValue('denied');
    render(
      <QueryProvider>
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('mail://new', expect.any(Function)),
    );
    act(() =>
      ipc.emit('mail://new', {
        accountId: 'account-1',
        threadIds: ['thread-1'],
        arrivals: [{ sender: 'a@example.com', subject: 'Hi' }],
      }),
    );
    await waitFor(() => expect(Notification.requestPermission).toHaveBeenCalled());
    expect(window.__notifications__).toEqual([]);
  });

  it('notifies once permission is granted on request — the Windows path', async () => {
    (Notification as { permission: NotificationPermission }).permission = 'denied';
    render(
      <QueryProvider>
        <EventBridge />
      </QueryProvider>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('mail://new', expect.any(Function)),
    );
    act(() =>
      ipc.emit('mail://new', {
        accountId: 'account-1',
        threadIds: ['thread-1'],
        arrivals: [{ sender: 'a@example.com', subject: 'Hi' }],
      }),
    );
    await waitFor(() =>
      expect(window.__notifications__).toEqual([{ title: 'a@example.com', body: 'Hi' }]),
    );
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
    // Starts the debounce timer without letting it fire, so unmount's
    // cleanup (not the timer callback) is what clears it.
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
    expect(useToastStore.getState().toast?.message).toBe(
      'Send status unknown — check Sent and Drafts',
    );
    act(() =>
      ipc.emit('send://complete', {
        accountId: 'account-1',
        sessionId: 'session-1',
        draftId: 'draft-1',
      }),
    );
    expect(useToastStore.getState().toast?.message).toBe('Message sent.');
    // A failure for the still-open session belongs inline, not in a toast.
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
    expect(useToastStore.getState().toast?.message).toBe('Message sent.');
    // Once the composer has closed, the toast is the only channel left.
    act(() => useComposeStore.getState().close());
    act(() =>
      ipc.emit('compose://failed', {
        accountId: 'account-1',
        sessionId: 'session-1',
        kind: 'send',
        error: 'Gmail request failed with status 400',
      }),
    );
    expect(useToastStore.getState().toast?.message).toBe(
      'Couldn’t send message — Gmail request failed with status 400',
    );
    const beforeUnrelatedItem = invalidate.mock.calls.length;
    act(() => ipc.emit('queue://item', { id: 'queue:account-1:1', status: 'done' }));
    expect(invalidate).toHaveBeenCalledTimes(beforeUnrelatedItem);
    // A mutation that has only been queued or picked up has not written to
    // SQLite yet; invalidating here refetches the pre-mutation row and
    // visibly reverts the optimistic update mid-flight.
    act(() => ipc.emit('queue://item', { id: 'mutation:account-1:1', status: 'queued' }));
    act(() => ipc.emit('queue://item', { id: 'mutation:account-1:1', status: 'active' }));
    expect(invalidate).toHaveBeenCalledTimes(beforeUnrelatedItem);
    act(() => ipc.emit('queue://item', { id: 'mutation:account-1:1', status: 'done' }));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.threadsForAccount('account-1') });
  });
});
