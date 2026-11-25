import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { beforeEach, expect, it, vi } from 'vitest';
import { useAccountAvatarQuery, useSenderAvatarQuery } from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { useLayoutStore } from '@/stores/layout';
import { ipc } from '@/tests/ipc-mock';
import { resetHookTestStores, wrapper } from '@/tests/lib/query/hooks-helpers';

beforeEach(() => {
  resetHookTestStores();
});

beforeEach(() => {
  useLayoutStore.setState({ showSenderAvatars: true });
});

it('resolves the sender-avatar path through the asset URL resolver', async () => {
  ipc.override('read_sender_avatar', '/cache/senders/example.png');
  const { result } = renderHook(() => useSenderAvatarQuery('example.com'), {
    wrapper: wrapper(new QueryClient()),
  });
  await waitFor(() =>
    expect(result.current.data).toBe('asset://localhost/%2Fcache%2Fsenders%2Fexample.png'),
  );
});

it('does not issue a lookup at all while the preference is off', async () => {
  useLayoutStore.setState({ showSenderAvatars: false });
  const client = new QueryClient();
  const { result } = renderHook(() => useSenderAvatarQuery('example.com'), {
    wrapper: wrapper(client),
  });
  expect(result.current.fetchStatus).toBe('idle');

  expect(client.getQueryState(queryKeys.senderAvatar('example.com'))?.dataUpdateCount).toBe(0);
});

it('treats a rejected sender-avatar invoke identically to "no image", without surfacing an error', async () => {
  ipc.override('read_sender_avatar', () => Promise.reject(new Error('command not registered')));
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const { result } = renderHook(() => useSenderAvatarQuery('example.com'), {
    wrapper: wrapper(new QueryClient()),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
  expect(result.current.isError).toBe(false);
  expect(errorSpy).not.toHaveBeenCalled();
  errorSpy.mockRestore();
});

it('treats a rejected account-avatar invoke identically to "no image"', async () => {
  ipc.override('read_account_avatar', () => Promise.reject(new Error('command not registered')));
  const { result } = renderHook(() => useAccountAvatarQuery('account-1'), {
    wrapper: wrapper(new QueryClient()),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.data).toBeNull();
});

it('is not gated by the preference — the account photograph involves no third-party lookup', async () => {
  useLayoutStore.setState({ showSenderAvatars: false });
  ipc.override('read_account_avatar', null);
  const { result } = renderHook(() => useAccountAvatarQuery('account-1'), {
    wrapper: wrapper(new QueryClient()),
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
});
