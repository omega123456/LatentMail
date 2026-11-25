import { useEffect } from 'react';
import { toDate } from 'date-fns';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
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

type BridgeDebouncers = {
  queueSnapshot: ReturnType<typeof createDebouncedTrigger>;
  mailboxInvalidation: ReturnType<typeof createDebouncedFlush<string>>;
  traversalInvalidation: ReturnType<typeof createDebouncedFlush<string>>;
};

type BridgeSubscription = () => () => void;

function invalidateMailboxQueries(queryClient: QueryClient, accountId: string) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.searchForAccount(accountId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.searchTotalsForAccount(accountId) });
  void queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
}

function invalidateTraversalQueries(queryClient: QueryClient, accountId: string) {
  void queryClient.invalidateQueries({
    queryKey: queryKeys.threadsForAccount(accountId),
    refetchType: 'none',
  });
  void queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId) });
}

function on<Event extends keyof IpcEventMap>(
  event: Event,
  handler: (payload: IpcEventMap[Event]) => void,
): BridgeSubscription {
  return () =>
    listenUntilDisposed(event, (payload) => {
      if (event !== 'queue://summary') appLog.info(`event ${event} ${JSON.stringify(payload)}`);
      handler(payload);
    });
}

function createBridgeDebouncers(queryClient: QueryClient): BridgeDebouncers {
  return {
    queueSnapshot: createDebouncedTrigger(QUEUE_SNAPSHOT_DEBOUNCE_MS, () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.queueOperations });
    }),
    mailboxInvalidation: createDebouncedFlush<string>(
      MAILBOX_INVALIDATION_DEBOUNCE_MS,
      (accountIds) => {
        accountIds.forEach((accountId) => invalidateMailboxQueries(queryClient, accountId));
      },
    ),
    traversalInvalidation: createDebouncedFlush<string>(
      TRAVERSAL_INVALIDATION_DEBOUNCE_MS,
      (accountIds) => {
        accountIds.forEach((accountId) => invalidateTraversalQueries(queryClient, accountId));
      },
    ),
  };
}

function mergeAiIndexStatus(
  statuses: AiIndexStatus[] | undefined,
  event: IpcEventMap['ai://index'],
): AiIndexStatus[] {
  const current = statuses ?? [];
  const next: AiIndexStatus = {
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
  if (!found) return [...current, next];
  return current.map((status) =>
    status.accountId === event.accountId ? { ...status, ...next } : status,
  );
}

function handleComposeFailed(event: IpcEventMap['compose://failed']) {
  const compose = useComposeStore.getState();
  const matchesSession =
    compose.session?.id === event.sessionId || compose.session?.draftId === event.sessionId;
  if (matchesSession) {
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
}

function createQueueAndAccountSubscriptions(
  queryClient: QueryClient,
  debouncers: BridgeDebouncers,
): BridgeSubscription[] {
  return [
    on('queue://summary', (summary) => {
      useSyncStore.getState().setQueue(summary);
      debouncers.queueSnapshot.trigger();
    }),
    on('queue://item', (item) => {
      debouncers.queueSnapshot.trigger();
      const finished = item.status === 'done' || item.status === 'failed';
      const finishedMutation = finished && item.id.startsWith('mutation:');
      if (!finishedMutation) return;
      debouncers.mailboxInvalidation.add(item.accountId);
    }),
    on('avatar://resolved', (event) => {
      const avatarKey =
        event.pipeline === 'sender'
          ? queryKeys.senderAvatar(event.key)
          : queryKeys.accountAvatar(event.key);
      void queryClient.invalidateQueries({ queryKey: avatarKey });
    }),
    on('account://state', () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    }),
    on('account://removed', () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    }),
  ];
}

function createAiSubscriptions(queryClient: QueryClient): BridgeSubscription[] {
  return [
    on('ai://config', (event) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiConfigs });
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiIndexStatuses });
      if (event.removed) {
        queryClient.setQueryData(
          queryKeys.aiIndexStatuses,
          (statuses: Array<{ accountId: string }> | undefined) =>
            statuses?.filter((status) => status.accountId !== event.accountId),
        );
      }
    }),
    on('ai://index', (event) => {
      queryClient.setQueryData(queryKeys.aiIndexStatuses, (statuses: AiIndexStatus[] | undefined) =>
        mergeAiIndexStatus(statuses, event),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.aiIndexStatuses });
    }),
  ];
}

function createSyncAndMailSubscriptions(
  queryClient: QueryClient,
  debouncers: BridgeDebouncers,
): BridgeSubscription[] {
  return [
    on('sync://progress', (progress) => {
      useSyncStore.getState().setSyncState(progress.state);
    }),
    on('sync://traversal', (progress) => {
      queryClient.setQueryData(queryKeys.traversalStatus(progress.accountId), {
        accountId: progress.accountId,
        state: progress.state,
        kind: progress.kind,
        discoveredCount: progress.discoveredCount,
        persistedCount: progress.persistedCount,
        lastAdvancedAt: progress.lastAdvancedAt,
        isResumed: progress.isResumed,
      });
      debouncers.traversalInvalidation.add(progress.accountId);
    }),
    on('sync://complete', (event) => {
      useSyncStore.setState({
        syncState: 'idle',
        lastSynced: toDate(event.completedAt),
        error: undefined,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.syncStatus(event.accountId) });
      if (event.changed) debouncers.mailboxInvalidation.add(event.accountId);
    }),
    on('mail://new', (event) => {
      debouncers.mailboxInvalidation.add(event.accountId);
    }),
    on('mail://changed', (event) => {
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
    }),
    on('message://body-fetched', (event) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.messageBodiesForMessage(event.accountId, event.messageId),
      });
    }),
  ];
}

function createComposeAndOsSubscriptions(queryClient: QueryClient): BridgeSubscription[] {
  return [
    on('os://intent', (intent) => {
      void handleOsIntent(intent);
    }),
    on('send://uncertain', () => {
      useToastStore.getState().showError('Send status unknown — check Sent and Drafts.');
    }),
    on('draft://saved', (event) => {
      const session = useComposeStore.getState().session;
      if (session?.id === event.sessionId) {
        useComposeStore.getState().setDraftId(event.draftId);
        useComposeStore.getState().markSaved();
      }
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
    }),
    on('send://complete', (event) => {
      useToastStore.getState().showSuccess('Message sent.');
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(event.accountId),
      });
    }),
    on('compose://failed', handleComposeFailed),
  ];
}

function createEventSubscriptions(
  queryClient: QueryClient,
  debouncers: BridgeDebouncers,
): BridgeSubscription[] {
  return [
    ...createQueueAndAccountSubscriptions(queryClient, debouncers),
    ...createAiSubscriptions(queryClient),
    ...createSyncAndMailSubscriptions(queryClient, debouncers),
    ...createComposeAndOsSubscriptions(queryClient),
  ];
}

export function subscribeQueryBridge(queryClient: QueryClient): () => void {
  void emitFrontendReady();
  const debouncers = createBridgeDebouncers(queryClient);
  const subscriptions = createEventSubscriptions(queryClient, debouncers);
  const disposers = subscriptions.map((subscribe) => subscribe());
  return () => {
    debouncers.traversalInvalidation.cancel();
    debouncers.mailboxInvalidation.cancel();
    debouncers.queueSnapshot.cancel();
    disposers.forEach((dispose) => dispose());
  };
}

export function EventBridge() {
  const queryClient = useQueryClient();
  useEffect(() => subscribeQueryBridge(queryClient), [queryClient]);
  return null;
}
