import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import {
  useCreateLabelMutation,
  useDeleteLabelMutation,
  useRecolorLabelMutation,
  useRenameLabelMutation,
} from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { ipc } from '@/tests/ipc-mock';

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

describe('label lifecycle mutations', () => {
  it('creates a label and invalidates the labels query on success', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.labels('account-1'), []);
    const { result } = renderHook(() => useCreateLabelMutation('account-1'), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ name: 'Contracts', colorId: 'red' });
    });
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.labels('account-1'))?.isInvalidated).toBe(true),
    );
  });

  it('rejects with the mutation error so the caller can surface it inline', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipc.override('rename_label', () =>
      Promise.reject(new Error('a label with this name already exists')),
    );
    const client = new QueryClient();
    const { result } = renderHook(() => useRenameLabelMutation('account-1'), {
      wrapper: wrapper(client),
    });
    await expect(
      act(() => result.current.mutateAsync({ labelId: 'Label_1', name: 'Clients' })),
    ).rejects.toThrow('a label with this name already exists');
    error.mockRestore();
  });

  it('recolours and deletes, invalidating the labels query either way', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.labels('account-1'), []);
    const recolor = renderHook(() => useRecolorLabelMutation('account-1'), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await recolor.result.current.mutateAsync({ labelId: 'Label_1', colorId: 'blue' });
    });
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.labels('account-1'))?.isInvalidated).toBe(true),
    );

    client.setQueryData(queryKeys.labels('account-1'), []);
    const deleteHook = renderHook(() => useDeleteLabelMutation('account-1'), {
      wrapper: wrapper(client),
    });
    await act(async () => {
      await deleteHook.result.current.mutateAsync({ labelId: 'Label_1' });
    });
    await waitFor(() =>
      expect(client.getQueryState(queryKeys.labels('account-1'))?.isInvalidated).toBe(true),
    );
  });
});
