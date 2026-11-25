import { getTime, parseISO } from 'date-fns';
import { act, render } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { EventBridge } from '@/lib/query/event-bridge';
import { useThreadsQuery } from '@/lib/query/hooks';
import { QueryProvider } from '@/providers/QueryProvider';
import { useSyncStore } from '@/stores/sync';

export const RUST_COMPLETED_AT = getTime(parseISO('2026-08-11T10:00:00Z'));

type QueryClientHandle = ReturnType<typeof useQueryClient>;

export function captureQueryClient() {
  let captured: QueryClientHandle | undefined;
  return {
    receive: (readyClient: QueryClientHandle) => {
      captured = readyClient;
    },
    client: (): QueryClientHandle => {
      if (!captured) throw new Error('query client was not captured');
      return captured;
    },
  };
}

export function SpyClient({
  onReady,
}: {
  onReady: (client: ReturnType<typeof useQueryClient>) => void;
}) {
  onReady(useQueryClient());
  return null;
}

export function ThreadQuery({
  onReady,
}: {
  onReady: (query: ReturnType<typeof useThreadsQuery>) => void;
}) {
  onReady(useThreadsQuery('account-1', 'INBOX'));
  return null;
}

export function resetEventBridgeSyncStore() {
  act(() =>
    useSyncStore.setState({
      queue: { pending: 0, active: 0, failed: 0, done: 0, paused: false, suspended: false },
      syncState: 'idle',
      lastSynced: null,
    }),
  );
}

export function renderEventBridge() {
  const clientCapture = captureQueryClient();
  render(
    <QueryProvider>
      <SpyClient onReady={clientCapture.receive} />
      <EventBridge />
    </QueryProvider>,
  );
  return clientCapture;
}
