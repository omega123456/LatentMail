import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { emitFrontendReady, listen } from '@/lib/ipc/events';
import { useSyncStore } from '@/stores/sync';
import type { IpcEventMap } from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useComposeStore } from '@/stores/compose';
import { appLog } from '@/lib/app-log';
import { handleOsIntent } from '@/lib/os/intent';

export function EventBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    void emitFrontendReady();
    let disposed = false;
    const unlistens: Array<() => void | Promise<void>> = [];
    const traversalAccounts = new Set<string>();
    let traversalTimer: number | undefined;
    const mailboxInvalidationAccounts = new Set<string>();
    let mailboxInvalidationTimer: number | undefined;
    let queueSnapshotTimer: number | undefined;
    const scheduleQueueSnapshotInvalidation = () => {
      if (queueSnapshotTimer !== undefined) return;
      queueSnapshotTimer = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: queryKeys.queueOperations });
        queueSnapshotTimer = undefined;
      }, 250);
    };
    const scheduleMailboxInvalidation = (accountId: string) => {
      mailboxInvalidationAccounts.add(accountId);
      if (mailboxInvalidationTimer !== undefined) return;
      mailboxInvalidationTimer = window.setTimeout(() => {
        mailboxInvalidationAccounts.forEach((accountId) => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.threadsForAccount(accountId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.searchForAccount(accountId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.searchTotalsForAccount(accountId),
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
        });
        mailboxInvalidationAccounts.clear();
        mailboxInvalidationTimer = undefined;
      }, 250);
    };
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
      scheduleQueueSnapshotInvalidation();
    });

    subscribe('sync://progress', (progress) => {
      useSyncStore.getState().setSyncState(progress.state);
    });

    subscribe('sync://traversal', (progress) => {
      queryClient.setQueryData(queryKeys.traversalStatus(progress.accountId), {
        accountId: progress.accountId,
        state: progress.state,
        kind: progress.kind,
        discoveredCount: progress.discoveredCount,
        persistedCount: progress.persistedCount,
        lastAdvancedAt: progress.lastAdvancedAt,
        isResumed: progress.isResumed,
      });
      traversalAccounts.add(progress.accountId);
      if (traversalTimer !== undefined) return;
      traversalTimer = window.setTimeout(() => {
        traversalAccounts.forEach((accountId) => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.threadsForAccount(accountId),
            refetchType: 'none',
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
        });
        traversalAccounts.clear();
        traversalTimer = undefined;
      }, 1000);
    });

    subscribe('sync://complete', (event) => {
      useSyncStore.setState({ syncState: 'idle', lastSynced: new Date(), error: undefined });
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus(event.accountId) });
      if (!event.changed) return;
      scheduleMailboxInvalidation(event.accountId);
    });

    subscribe('mail://new', (event) => {
      scheduleMailboxInvalidation(event.accountId);
    });

    subscribe('message://body-fetched', (event) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messageBodiesForMessage(event.accountId, event.messageId),
      });
    });

    subscribe('os://intent', (intent) => {
      void handleOsIntent(intent);
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
      scheduleQueueSnapshotInvalidation();
      if (item.status !== 'done' && item.status !== 'failed') return;
      if (!item.id.startsWith('mutation:')) return;
      const accountId = item.id.split(':')[1];
      if (accountId) {
        scheduleMailboxInvalidation(accountId);
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
      if (mailboxInvalidationTimer !== undefined) window.clearTimeout(mailboxInvalidationTimer);
      if (queueSnapshotTimer !== undefined) window.clearTimeout(queueSnapshotTimer);
      unlistens.forEach((remove) => void remove());
    };
  }, [queryClient]);
  return null;
}
