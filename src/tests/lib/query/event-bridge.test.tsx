import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventBridge } from '@/lib/query/event-bridge';
import { queryKeys } from '@/lib/query/keys';
import { QueryProvider } from '@/providers/QueryProvider';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';
import {
  SpyClient,
  captureQueryClient,
  resetEventBridgeSyncStore,
} from '@/tests/lib/query/event-bridge-helpers';

describe('EventBridge', () => {
  beforeEach(() => vi.spyOn(console, 'info').mockImplementation(() => undefined));

  afterEach(() => {
    vi.useRealTimers();
    resetEventBridgeSyncStore();
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
});
