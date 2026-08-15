import { act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSyncStore } from '@/stores/sync';
import { ipc } from '@/tests/ipc-mock';

afterEach(() =>
  act(() =>
    useSyncStore.setState({
      syncState: 'idle',
      lastSynced: null,
      accountId: null,
      refreshing: false,
      error: undefined,
    }),
  ),
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

  it('surfaces a sync error from the status DTO', async () => {
    ipc.override('read_sync_status', {
      accountId: 'account-1',
      state: 'error',
      lastSyncedAt: null,
      lastError: 'Gmail is unavailable',
    });
    await act(() => useSyncStore.getState().hydrateSync('account-1'));
    expect(useSyncStore.getState().error).toBe('Gmail is unavailable');
  });
});
