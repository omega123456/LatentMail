import { act, render, waitFor } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventBridge } from '@/lib/query/event-bridge';
import { queryKeys } from '@/lib/query/keys';
import { QueryProvider } from '@/providers/QueryProvider';
import { useSyncStore } from '@/stores/sync';
import { ipc } from '@/tests/ipc-mock';

function SpyClient({ onReady }: { onReady: (client: ReturnType<typeof useQueryClient>) => void }) {
  onReady(useQueryClient());
  return null;
}

describe('EventBridge', () => {
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
      ipc.emit('sync://complete', { accountId: 'account-1', historyId: 42, addedCount: 3 }),
    );
    expect(useSyncStore.getState().syncState).toBe('idle');
    expect(useSyncStore.getState().lastSynced).toBeInstanceOf(Date);
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
    act(() => ipc.emit('mail://new', { accountId: 'account-1', threadIds: ['thread-1'] }));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: queryKeys.threadsForAccount('account-1'),
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.labels('account-1') });
  });
});
