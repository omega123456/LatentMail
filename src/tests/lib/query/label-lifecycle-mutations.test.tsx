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
import type { MailLabel } from '@/lib/types/ipc';
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

  it('shows the created, renamed and deleted label before the request settles', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.labels('account-1'), [
      {
        id: 'Label_1',
        name: 'Clients',
        kind: 'user',
        color: { text: '#ffffff', background: '#4a86e8' },
        messageCount: 0,
        unreadCount: 0,
      },
    ]);
    const pending = new Promise<never>(() => undefined);
    ipc.override('create_label', () => pending);
    ipc.override('rename_label', () => pending);
    ipc.override('delete_label', () => pending);

    const create = renderHook(() => useCreateLabelMutation('account-1'), {
      wrapper: wrapper(client),
    });
    act(() => create.result.current.mutate({ name: 'Archive', colorId: 'red' }));
    await waitFor(() =>
      expect(client.getQueryData<MailLabel[]>(queryKeys.labels('account-1'))).toEqual([
        expect.objectContaining({
          name: 'Archive',
          color: { text: '#ffffff', background: '#fb4c2f' },
        }),
        expect.objectContaining({ name: 'Clients' }),
      ]),
    );

    const rename = renderHook(() => useRenameLabelMutation('account-1'), {
      wrapper: wrapper(client),
    });
    act(() => rename.result.current.mutate({ labelId: 'Label_1', name: 'Zebra' }));
    await waitFor(() =>
      expect(
        client.getQueryData<MailLabel[]>(queryKeys.labels('account-1'))?.map((l) => l.name),
      ).toEqual(['Archive', 'Zebra']),
    );

    const remove = renderHook(() => useDeleteLabelMutation('account-1'), {
      wrapper: wrapper(client),
    });
    act(() => remove.result.current.mutate({ labelId: 'Label_1' }));
    await waitFor(() =>
      expect(
        client.getQueryData<MailLabel[]>(queryKeys.labels('account-1'))?.map((l) => l.name),
      ).toEqual(['Archive']),
    );
  });

  it('recolours the cached label before the request settles', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.labels('account-1'), [
      {
        id: 'Label_1',
        name: 'Clients',
        kind: 'user',
        color: { text: '#ffffff', background: '#4a86e8' },
        messageCount: 0,
        unreadCount: 0,
      },
    ]);
    ipc.override('recolor_label', () => new Promise<never>(() => undefined));
    const { result } = renderHook(() => useRecolorLabelMutation('account-1'), {
      wrapper: wrapper(client),
    });
    act(() => result.current.mutate({ labelId: 'Label_1', colorId: 'red' }));
    await waitFor(() =>
      expect(client.getQueryData<MailLabel[]>(queryKeys.labels('account-1'))?.[0].color).toEqual({
        text: '#ffffff',
        background: '#fb4c2f',
      }),
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
