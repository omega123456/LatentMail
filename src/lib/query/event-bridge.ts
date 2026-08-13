import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@/lib/ipc/events';
import { useSyncStore } from '@/stores/sync';
import type { IpcEventMap } from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useComposeStore } from '@/stores/compose';

/** Bridges Rust events onto TanStack Query invalidation and the Zustand
 * stores that mirror queue/sync state. This is the ONLY place allowed to
 * invalidate queries or push store updates from IPC events — components
 * must never invalidate/refetch by hand (see CLAUDE.md). */
export function EventBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    let disposed = false;
    const unlistens: Array<() => void | Promise<void>> = [];
    const traversalAccounts = new Set<string>();
    let traversalTimer: number | undefined;
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

    subscribe('sync://traversal', (progress) => {
      traversalAccounts.add(progress.accountId);
      if (traversalTimer !== undefined) return;
      traversalTimer = window.setTimeout(() => {
        traversalAccounts.forEach((accountId) => {
          void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.traversalStatus(accountId) });
        });
        traversalAccounts.clear();
        traversalTimer = undefined;
      }, 250);
    });

    subscribe('sync://complete', (event) => {
      useSyncStore.setState({ syncState: 'idle', lastSynced: new Date(), error: undefined });
      // Threads, label counts and the seeded sync status all changed —
      // refresh the visible list without a manual reload (acceptance
      // criterion 7).
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus(event.accountId) });
    });

    subscribe('mail://new', (event) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
    });

    subscribe('send://uncertain', () => {
      useToastStore.getState().showError('Send status unknown — check Sent and Drafts');
    });
    subscribe('draft://saved', (event) => {
      const session = useComposeStore.getState().session;
      if (session?.id === event.sessionId) {
        useComposeStore.getState().setDraftId(event.draftId);
        useComposeStore.getState().markSaved();
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
    });
    subscribe('send://complete', (event) => {
      useToastStore.getState().showSuccess('Message sent.');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
    });

    // The composer closes on queue acceptance, not on delivery, so a
    // failure that happens after it closed has nowhere to render but a
    // toast; while the same session is still open it belongs inline.
    subscribe('compose://failed', (event) => {
      const message =
        event.kind === 'send' ? `Couldn’t send message — ${event.error}` : 'Couldn’t save draft';
      const compose = useComposeStore.getState();
      if (compose.session?.id === event.sessionId || compose.session?.draftId === event.sessionId) {
        compose.setDraftStatus('failed', message);
        return;
      }
      useToastStore.getState().showError(message);
    });

    subscribe('queue://item', (item) => {
      if (!item.id.startsWith('mutation:')) return;
      const accountId = item.id.split(':')[1];
      if (accountId)
        void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId) });
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
      if (traversalTimer !== undefined) window.clearTimeout(traversalTimer);
      unlistens.forEach((remove) => void remove());
    };
  }, [queryClient]);
  return null;
}
