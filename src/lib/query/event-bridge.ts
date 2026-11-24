import { useEffect } from 'react';
import { toDate } from 'date-fns';
import { useQueryClient } from '@tanstack/react-query';
import { emitFrontendReady } from '@/lib/ipc/events';
import { listenUntilDisposed } from '@/lib/ipc/listen-managed';
import { createDebouncedFlush, createDebouncedTrigger } from '@/lib/debounced-flush';
import { useSyncStore } from '@/stores/sync';
import type { AiIndexStatus, IpcEventMap } from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useComposeStore } from '@/stores/compose';
import { appLog } from '@/lib/app-log';
import { handleOsIntent } from '@/lib/os/intent';

export const QUEUE_SNAPSHOT_DEBOUNCE_MS = 250;
export const MAILBOX_INVALIDATION_DEBOUNCE_MS = 250;
export const TRAVERSAL_INVALIDATION_DEBOUNCE_MS = 1000;

export function EventBridge() {
  const queryClient = useQueryClient();
  useEffect(() => {
    void emitFrontendReady();
    const disposers: Array<() => void> = [];
    const queueSnapshot = createDebouncedTrigger(QUEUE_SNAPSHOT_DEBOUNCE_MS, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.queueOperations });
    });
    const mailboxInvalidation = createDebouncedFlush<string>(
      MAILBOX_INVALIDATION_DEBOUNCE_MS,
      (accountIds) => {
        accountIds.forEach((pendingAccountId) => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.threadsForAccount(pendingAccountId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.searchForAccount(pendingAccountId),
          });
          void queryClient.invalidateQueries({
            queryKey: queryKeys.searchTotalsForAccount(pendingAccountId),
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.labels(pendingAccountId) });
        });
      },
    );
    const traversalInvalidation = createDebouncedFlush<string>(
      TRAVERSAL_INVALIDATION_DEBOUNCE_MS,
      (accountIds) => {
        accountIds.forEach((accountId) => {
          void queryClient.invalidateQueries({
            queryKey: queryKeys.threadsForAccount(accountId),
            refetchType: 'none',
          });
          void queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
        });
      },
    );
    const subscribe = <Event extends keyof IpcEventMap>(
      event: Event,
      handler: (payload: IpcEventMap[Event]) => void,
    ) => {
      const logged = (payload: IpcEventMap[Event]) => {
        if (event !== 'queue://summary') appLog.info(`event ${event} ${JSON.stringify(payload)}`);
        handler(payload);
      };
      disposers.push(listenUntilDisposed(event, logged));
    };

    subscribe('queue://summary', (summary) => {
      useSyncStore.getState().setQueue(summary);
      queueSnapshot.trigger();
    });
    subscribe('ai://config', (event) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiConfigs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiIndexStatuses });
      if (event.removed) {
        queryClient.setQueryData(
          queryKeys.aiIndexStatuses,
          (statuses: Array<{ accountId: string }> | undefined) =>
            statuses?.filter((status) => status.accountId !== event.accountId),
        );
      }
    });
    subscribe('ai://index', (event) => {
      queryClient.setQueryData(
        queryKeys.aiIndexStatuses,
        (statuses: AiIndexStatus[] | undefined) => {
          const current = statuses ?? [];
          const next = {
            accountId: event.accountId,
            indexed: event.indexed,
            total: event.total,
            indexedMessages: event.indexedMessages,
            totalEligibleMessages: event.totalEligibleMessages,
            indexedPassages: event.indexedPassages,
            state: event.state,
            paused: event.paused,
            error: event.error,
          };
          const found = current.some((status) => status.accountId === event.accountId);
          return found
            ? current.map((status) =>
                status.accountId === event.accountId ? { ...status, ...next } : status,
              )
            : [...current, next];
        },
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiIndexStatuses });
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
      traversalInvalidation.add(progress.accountId);
    });

    subscribe('sync://complete', (event) => {
      useSyncStore.setState({
        syncState: 'idle',
        lastSynced: toDate(event.completedAt),
        error: undefined,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus(event.accountId) });
      if (!event.changed) return;
      mailboxInvalidation.add(event.accountId);
    });

    subscribe('mail://new', (event) => {
      mailboxInvalidation.add(event.accountId);
    });

    subscribe('mail://changed', (event) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversationsForAccount(event.accountId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.searchForAccount(event.accountId) });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.searchTotalsForAccount(event.accountId),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.labels(event.accountId) });
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
      queueSnapshot.trigger();
      if (item.status !== 'done' && item.status !== 'failed') return;
      if (!item.id.startsWith('mutation:')) return;
      mailboxInvalidation.add(item.accountId);
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

    subscribe('account://removed', () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    });

    return () => {
      traversalInvalidation.cancel();
      mailboxInvalidation.cancel();
      queueSnapshot.cancel();
      disposers.forEach((dispose) => dispose());
    };
  }, [queryClient]);
  return null;
}
