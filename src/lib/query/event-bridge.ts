import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@/lib/ipc/events';
import { useSyncStore } from '@/stores/sync';
import type { IpcEventMap } from '@/lib/types/ipc';
import { queryKeys } from './keys';

/** Bridges Rust events onto TanStack Query invalidation and the Zustand
 * stores that mirror queue/sync state. This is the ONLY place allowed to
 * invalidate queries or push store updates from IPC events — components
 * must never invalidate/refetch by hand (see CLAUDE.md). */
export function EventBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void | Promise<void>> = [];
    const subscribe = <E extends keyof IpcEventMap>(
      event: E,
      handler: (payload: IpcEventMap[E]) => void,
    ) => {
      void listen(event, handler).then((remove) => {
        if (disposed) void remove();
        else unlistens.push(remove);
      });
    };

    subscribe('queue://summary', (summary) => {
      useSyncStore.getState().setQueue(summary);
    });

    subscribe('sync://progress', (progress) => {
      useSyncStore.setState({ syncState: progress.state });
    });

    subscribe('sync://complete', (event) => {
      useSyncStore.setState({ syncState: 'idle', lastSynced: new Date(), error: undefined });
      // Threads, label counts and the seeded sync status all changed —
      // refresh the visible list without a manual reload (acceptance
      // criterion 7).
      void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(event.accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus(event.accountId) });
    });

    subscribe('mail://new', (event) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(event.accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
    });

    subscribe('account://state', () => {
      // Without this, the reauth banner (which renders off the accounts
      // query) would not appear live until something else happened to
      // refetch accounts — this is what makes a token-refresh failure show
      // up without any other user action (acceptance criterion 10).
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    });

    return () => {
      disposed = true;
      unlistens.forEach((remove) => void remove());
    };
  }, [queryClient]);
  return null;
}
