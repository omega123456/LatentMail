import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSyncStore } from '@/stores/sync';
import { useToastStore } from '@/stores/toast';
import { ipc } from '@/tests/ipc-mock';

afterEach(() =>
  act(() => {
    useSyncStore.setState({
      syncState: 'idle',
      lastSynced: null,
      accountId: null,
      refreshing: false,
      error: undefined,
    });
    useToastStore.setState({ toasts: [] });
  }),
);

describe('useSyncStore', () => {
  it('seeds lastSynced/syncState from read_sync_status before any sync completes', async () => {
    ipc.override('read_sync_status', {
      accountId: 'account-1',
      state: 'idle',
      lastSyncedAt: Date.parse('2026-08-11T09:00:00Z'),
      lastError: null,
    });
    await act(() => useSyncStore.getState().hydrateSync('account-1'));
    const state = useSyncStore.getState();
    expect(state.lastSynced).toEqual(new Date('2026-08-11T09:00:00Z'));
    expect(state.syncState).toBe('idle');
  });

  it('leaves lastSynced null when the account has never synced', async () => {
    ipc.override('read_sync_status', {
      accountId: 'account-1',
      state: 'idle',
      lastSyncedAt: null,
      lastError: null,
    });
    await act(() => useSyncStore.getState().hydrateSync('account-1'));
    expect(useSyncStore.getState().lastSynced).toBeNull();
  });

  it('triggers a real sync via trigger_sync and applies the returned status', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    ipc.override('trigger_sync', {
      accountId: 'account-1',
      state: 'idle',
      lastSyncedAt: Date.parse('2026-08-11T10:00:00Z'),
      lastError: null,
    });
    await act(() => useSyncStore.getState().triggerSync('account-1'));
    expect(useSyncStore.getState().lastSynced).toEqual(new Date('2026-08-11T10:00:00Z'));
    expect(useSyncStore.getState().refreshing).toBe(false);
    log.mockRestore();
  });

  it('surfaces a sync error from the status DTO, toasting bounded copy and logging the backend string', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipc.override('read_sync_status', {
      accountId: 'account-1',
      state: 'error',
      lastSyncedAt: null,
      lastError: 'Gmail is unavailable',
    });
    await act(() => useSyncStore.getState().hydrateSync('account-1'));
    expect(useSyncStore.getState().error).toBe('Gmail is unavailable');
    expect(useToastStore.getState().toasts).toEqual([
      {
        id: expect.any(Number),
        severity: 'error',
        message: "Couldn't sync your mail. Check your connection and try again.",
      },
    ]);
    expect(log).toHaveBeenCalledWith('sync failed: Gmail is unavailable');
    log.mockRestore();
  });

  it('toasts a sync failure once per entry into the error state, not on every update', () => {
    act(() => useSyncStore.getState().setSyncState('error'));
    act(() => useSyncStore.getState().setSyncState('error'));
    expect(useToastStore.getState().toasts).toHaveLength(1);
    act(() => useSyncStore.getState().setSyncState('idle'));
    act(() => useSyncStore.getState().setSyncState('error'));
    expect(useToastStore.getState().toasts).toHaveLength(2);
  });
});
