import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { listen } from '@/lib/ipc/events';
import { useSyncStore } from '@/stores/sync';
import type { IpcEventMap, MailArrival } from '@/lib/types/ipc';
import { parseParticipant } from '@/lib/format/participants';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useComposeStore } from '@/stores/compose';
import { appLog } from '@/lib/app-log';

async function notifyArrivals(arrivals: MailArrival[]) {
  const [first, ...rest] = arrivals;
  if (!first) return;
  if (
    Notification.permission !== 'granted' &&
    (await Notification.requestPermission()) !== 'granted'
  ) {
    return;
  }
  const { name, address } = parseParticipant(first.sender);
  const subject = first.subject || '(No subject)';
  new Notification(name || address, {
    body: rest.length > 0 ? `${subject} — and ${rest.length} more` : subject,
  });
}

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
      const logged = (payload: IpcEventMap[E]) => {
        if (event !== 'queue://summary') appLog.info(`event ${event} ${JSON.stringify(payload)}`);
        handler(payload);
      };
      void listen(event, logged).then((remove) => {
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

    const logThreadCache = (accountId: string, when: string) => {
      const entries = queryClient.getQueriesData<{ pages: Array<{ items: unknown[] }> }>({
        queryKey: queryKeys.threadsForAccount(accountId),
      });
      const summary = entries
        .map(
          ([key, data]) =>
            `${JSON.stringify(key)}=${(data?.pages ?? []).reduce((total, page) => total + page.items.length, 0)}`,
        )
        .join(' ');
      appLog.info(`threads cache ${when}: ${summary || '(no query matched this key)'}`);
    };

    subscribe('sync://complete', (event) => {
      useSyncStore.setState({ syncState: 'idle', lastSynced: new Date(), error: undefined });
      if (!event.changed) return;
      logThreadCache(event.accountId, 'before sync://complete invalidate');
      void queryClient
        .invalidateQueries({ queryKey: queryKeys.threadsForAccount(event.accountId) })
        .then(() => logThreadCache(event.accountId, 'after sync://complete invalidate'));
      void queryClient.invalidateQueries({ queryKey: queryKeys.searchForAccount(event.accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus(event.accountId) });
    });

    subscribe('mail://new', (event) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.searchForAccount(event.accountId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
      void notifyArrivals(event.arrivals);
    });

    subscribe('send://uncertain', () => {
      useToastStore.getState().showError('Send status unknown — check Sent and Drafts.');
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

    subscribe('compose://failed', (event) => {
      const compose = useComposeStore.getState();
      if (compose.session?.id === event.sessionId || compose.session?.draftId === event.sessionId) {
        compose.setDraftStatus(
          'failed',
          event.kind === 'send' ? 'Couldn’t send.' : 'Couldn’t save draft.',
        );
        return;
      }
      appLog.error(`compose ${event.kind} failed: ${event.error}`);
      useToastStore
        .getState()
        .showError(event.kind === 'send' ? 'Couldn’t send your message.' : 'Couldn’t save draft.');
    });

    subscribe('queue://item', (item) => {
      if (item.status !== 'done' && item.status !== 'failed') return;
      if (!item.id.startsWith('mutation:')) return;
      const accountId = item.id.split(':')[1];
      if (accountId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.searchForAccount(accountId) });
      }
    });

    subscribe('avatar://resolved', (event) => {
      void queryClient.invalidateQueries({
        queryKey:
          event.pipeline === 'sender'
            ? queryKeys.senderAvatar(event.key)
            : queryKeys.accountAvatar(event.key),
      });
    });

    subscribe('account://state', () => {
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
