import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import {
  useCancelQueueOperationMutation,
  useClearQueueHistoryMutation,
  useQueueOperationsQuery,
  useRetryFailedOperationsMutation,
  useRetryQueueOperationMutation,
  useSetQueuePausedMutation,
} from '@/lib/query/hooks';
import { useToastStore } from '@/stores/toast';
import { ipc } from '@/tests/ipc-mock';
import { captureConsole } from '@/tests/console';
import { resetHookTestStores, wrapper } from '@/tests/lib/query/hooks-helpers';

beforeEach(() => {
  resetHookTestStores();
});

it('reads the queue snapshot', async () => {
  const client = new QueryClient();
  ipc.override('read_queue_operations', []);
  const { result } = renderHook(() => useQueueOperationsQuery(), { wrapper: wrapper(client) });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toEqual([]);
});

it('cancels an operation and reports whether it applied', async () => {
  const client = new QueryClient();
  ipc.override('cancel_queue_operation', false);
  const { result } = renderHook(() => useCancelQueueOperationMutation(), {
    wrapper: wrapper(client),
  });
  const applied = await act(async () => result.current.mutateAsync('op-1'));
  expect(applied).toBe(false);
});

it('retries a single operation', async () => {
  const client = new QueryClient();
  const retry = vi.fn(() => true);
  ipc.override('retry_queue_operation', retry);
  const { result } = renderHook(() => useRetryQueueOperationMutation(), {
    wrapper: wrapper(client),
  });
  await act(async () => result.current.mutateAsync('op-1'));
  expect(retry).toHaveBeenCalledWith({ operationId: 'op-1' });
});

it('retries every failed operation, optionally scoped to an account', async () => {
  const client = new QueryClient();
  const retriedCount = 2;
  const retryAll = vi.fn(() => retriedCount);
  ipc.override('retry_failed_operations', retryAll);
  const { result } = renderHook(() => useRetryFailedOperationsMutation(), {
    wrapper: wrapper(client),
  });
  await act(async () => result.current.mutateAsync('account-1'));
  expect(retryAll).toHaveBeenCalledWith({ accountId: 'account-1' });
});

it('clears queue history', async () => {
  const client = new QueryClient();
  const clear = vi.fn();
  ipc.override('clear_queue_history', clear);
  const { result } = renderHook(() => useClearQueueHistoryMutation(), {
    wrapper: wrapper(client),
  });
  await act(async () => result.current.mutateAsync(undefined));
  expect(clear).toHaveBeenCalledWith({ accountId: null });
});

it('sets the paused flag at the requested scope', async () => {
  const client = new QueryClient();
  const setPaused = vi.fn(() => true);
  ipc.override('set_queue_paused', setPaused);
  const { result } = renderHook(() => useSetQueuePausedMutation(), { wrapper: wrapper(client) });
  await act(async () => result.current.mutateAsync({ scope: { scope: 'global' }, paused: true }));
  expect(setPaused).toHaveBeenCalledWith({ scope: { scope: 'global' }, paused: true });
});

it('surfaces a toast when a queue control command fails', async () => {
  const consoleError = captureConsole('error');
  const client = new QueryClient();
  ipc.override('set_queue_paused', () => {
    throw new Error('boom');
  });
  const { result } = renderHook(() => useSetQueuePausedMutation(), { wrapper: wrapper(client) });
  await act(async () => {
    await result.current.mutateAsync({ scope: { scope: 'global' }, paused: true }).catch(() => {});
  });
  expect(useToastStore.getState().toasts.at(-1)?.message).toBe('Couldn’t update the pause state.');
  expect(consoleError).toHaveBeenCalledWith('ipc set_queue_paused failed: boom');
});
