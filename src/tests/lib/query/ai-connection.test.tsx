import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  AI_CONNECTION_INTERVAL_MS,
  useAiConnectionQuery,
  useWindowVisible,
} from '@/lib/query/hooks';
import { queryKeys } from '@/lib/query/keys';
import { ipc } from '@/tests/ipc-mock';

function wrapper(client: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

describe('AI connection query', () => {
  it('keys the poll per account and polls every five minutes', () => {
    expect(queryKeys.aiConnection('account-1')).toEqual(['aiConnection', 'account-1']);
    expect(AI_CONNECTION_INTERVAL_MS).toBe(300_000);
  });

  it('reports the model count once the provider answers', async () => {
    ipc.override('test_ai_connection', 4);
    const client = new QueryClient();
    const { result } = renderHook(() => useAiConnectionQuery('account-1'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.data).toBe(4));
    client.clear();
  });

  it('does not retry a failed poll', async () => {
    const probe = vi.fn(() => {
      throw new Error('Could not connect to provider');
    });
    ipc.override('test_ai_connection', probe);
    const client = new QueryClient();
    const { result } = renderHook(() => useAiConnectionQuery('account-1'), {
      wrapper: wrapper(client),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(probe).toHaveBeenCalledTimes(1);
    client.clear();
  });

  it('stops while the window is hidden and resumes when it is visible again', async () => {
    const probe = vi.fn(() => 2);
    ipc.override('test_ai_connection', probe);
    setVisibility('hidden');
    const client = new QueryClient();
    const { result } = renderHook(() => useAiConnectionQuery('account-1'), {
      wrapper: wrapper(client),
    });
    expect(result.current.fetchStatus).toBe('idle');
    expect(probe).not.toHaveBeenCalled();
    setVisibility('visible');
    await waitFor(() => expect(probe).toHaveBeenCalledTimes(1));
    client.clear();
  });

  it('stays disabled for a caller that has not enabled it', () => {
    const probe = vi.fn(() => 2);
    ipc.override('test_ai_connection', probe);
    const client = new QueryClient();
    renderHook(() => useAiConnectionQuery('account-1', false), { wrapper: wrapper(client) });
    expect(probe).not.toHaveBeenCalled();
    client.clear();
  });

  it('reads the window as visible by default', () => {
    setVisibility('visible');
    const { result } = renderHook(() => useWindowVisible());
    expect(result.current).toBe(true);
  });
});
