import {
  useMutation,
  useQueryClient,
  type QueryClient,
  type QueryKey,
} from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import type {
  MailLabel,
  MailThread,
  MoveDestination,
  ThreadPage,
  ThreadSearchPage,
} from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import {
  appendPendingLabel,
  applyMessageLabelChange,
  applyMessageTriageChange,
  buildThreadTriageUpdater,
  formatFailureCopy,
  leavesMailboxForLabelChange,
  recolorCachedLabel,
  removeCachedLabel,
  renameCachedLabel,
  transformConversationMessages,
  transformThreadPages,
  virtualMailboxIdForScope,
  type ConversationMessagesUpdateTarget,
  type LabelLifecycleMutationOptions,
  type MessageTriageChange,
  type MessageTriageIntent,
  type ReaderMessageCacheEntry,
  type ThreadPagesUpdateTarget,
  type ThreadTransferMutationOptions,
  type ThreadTriageIntent,
  type TriageChange,
  type TriageIntent,
} from './optimistic-transforms';

export type {
  MessageTriageChange,
  MessageTriageIntent,
  ThreadTriageIntent,
  TriageChange,
  TriageIntent,
};

function useLabelLifecycleMutation<Request>({
  accountId,
  mutationFn,
  copy,
  optimistic,
}: LabelLifecycleMutationOptions<Request>) {
  const queryClient = useQueryClient();
  const showSuccess = useToastStore((toaster) => toaster.showSuccess);
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: mutationFn,
    onMutate: async (request: Request) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.labels(accountId ?? '') });
      queryClient.setQueryData<MailLabel[]>(
        queryKeys.labels(accountId ?? ''),
        (labels) => labels && optimistic(labels, request),
      );
    },
    onSuccess: () => showSuccess(copy.done),
    onError: () => showError(copy.failed),
  });
}

export function useCreateLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation({
    accountId: accountId,
    mutationFn: (request: { name: string; colorId: string | null }) =>
      invoke('create_label', { accountId: accountId as string, ...request }),
    copy: { done: 'Label created.', failed: 'Couldn’t create the label.' },
    optimistic: appendPendingLabel,
  });
}

export function useRenameLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation({
    accountId: accountId,
    mutationFn: (request: { labelId: string; name: string }) =>
      invoke('rename_label', { accountId: accountId as string, ...request }),
    copy: { done: 'Label renamed.', failed: 'Couldn’t rename the label.' },
    optimistic: renameCachedLabel,
  });
}

export function useRecolorLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation({
    accountId: accountId,
    mutationFn: (request: { labelId: string; colorId: string }) =>
      invoke('recolor_label', { accountId: accountId as string, ...request }),
    copy: { done: 'Label colour updated.', failed: 'Couldn’t update the colour.' },
    optimistic: recolorCachedLabel,
  });
}

export function useDeleteLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation({
    accountId: accountId,
    mutationFn: (request: { labelId: string }) =>
      invoke('delete_label', { accountId: accountId as string, ...request }),
    copy: { done: 'Label deleted.', failed: 'Couldn’t delete the label.' },
    optimistic: removeCachedLabel,
  });
}

function optimisticallyUpdatePages<Page extends ThreadPage | ThreadSearchPage>(
  queryClient: QueryClient,
  queryKey: QueryKey,
  options: {
    threadIds: string[];
    removesMatching: boolean;
    update: (thread: MailThread) => MailThread;
  },
) {
  queryClient.setQueriesData({ queryKey: queryKey }, (data: { pages: Page[] } | undefined) =>
    transformThreadPages(data, options),
  );
}

function optimisticallyUpdateThreadAndSearchPages(
  queryClient: QueryClient,
  target: ThreadPagesUpdateTarget,
) {
  const accountKey = target.accountId ?? '';
  optimisticallyUpdatePages<ThreadPage>(queryClient, queryKeys.threadsForAccount(accountKey), {
    threadIds: target.threadIds,
    removesMatching: target.leavesMailbox,
    update: target.update,
  });
  optimisticallyUpdatePages<ThreadSearchPage>(queryClient, queryKeys.searchForAccount(accountKey), {
    threadIds: target.threadIds,
    removesMatching: target.leavesSearch,
    update: target.update,
  });
  if (target.leavesSearch) {
    queryClient.setQueriesData<number>(
      { queryKey: queryKeys.searchTotalsForAccount(accountKey) },
      (total) => (total === undefined ? total : Math.max(0, total - target.threadIds.length)),
    );
  }
}

async function cancelThreadAndSearchQueries(queryClient: QueryClient, accountId: string | null) {
  const accountKey = accountId ?? '';
  await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountKey) });
  await queryClient.cancelQueries({ queryKey: queryKeys.searchForAccount(accountKey) });
}

function optimisticallyUpdateConversationMessages(
  queryClient: QueryClient,
  target: ConversationMessagesUpdateTarget,
) {
  queryClient.setQueriesData(
    { queryKey: queryKeys.conversationThread(target.accountId ?? '', target.threadId) },
    (data: { messages: ReaderMessageCacheEntry[] } | undefined) =>
      transformConversationMessages(data, {
        messageIds: target.messageIds,
        removesMessage: target.removesMessage,
        update: target.update,
      }),
  );
}

async function applyOptimisticThreadTriage(
  queryClient: QueryClient,
  accountId: string | null,
  { threadIds, add, remove }: TriageChange,
) {
  await cancelThreadAndSearchQueries(queryClient, accountId);
  const labels = queryClient.getQueryData<MailLabel[]>(queryKeys.labels(accountId ?? '')) ?? [];
  const update = buildThreadTriageUpdater({ labels, add, remove });
  for (const threadId of threadIds) {
    optimisticallyUpdateConversationMessages(queryClient, {
      accountId: accountId,
      threadId: threadId,
      messageIds: null,
      removesMessage: false,
      update: (message) => applyMessageLabelChange(message, add, remove),
    });
  }
  const mailboxId = useSelectionStore.getState().activeMailboxId;
  const scopeMailboxId = virtualMailboxIdForScope(useSearchStore.getState().scope);
  optimisticallyUpdateThreadAndSearchPages(queryClient, {
    accountId: accountId,
    threadIds: threadIds,
    leavesMailbox: leavesMailboxForLabelChange(mailboxId, add, remove),
    leavesSearch: leavesMailboxForLabelChange(scopeMailboxId, add, remove),
    update: update,
  });
}

export function useTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: TriageChange) =>
      invoke('mutate_threads', { accountId: accountId as string, ...change }),
    onMutate: (change) => applyOptimisticThreadTriage(queryClient, accountId, change),
    onError: (_error, { threadIds }) =>
      showError(formatFailureCopy('update', threadIds.length, 'conversation')),
  });
}

function useThreadTransferMutation<Change extends { threadIds: string[] }>({
  accountId,
  verb,
  mutationFn,
  destinationFor,
  clearActiveSelection,
}: ThreadTransferMutationOptions<Change>) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: mutationFn,
    onMutate: async (change: Change) => {
      await cancelThreadAndSearchQueries(queryClient, accountId);
      const activeThreadId = useSelectionStore.getState().activeThreadId ?? '';
      if (clearActiveSelection && change.threadIds.includes(activeThreadId)) {
        useSelectionStore.getState().clearSelection();
      }
      const destination = destinationFor(change);
      const mailboxId = useSelectionStore.getState().activeMailboxId;
      const scopeMailboxId = virtualMailboxIdForScope(useSearchStore.getState().scope);
      optimisticallyUpdateThreadAndSearchPages(queryClient, {
        accountId: accountId,
        threadIds: change.threadIds,
        leavesMailbox: mailboxId !== destination,
        leavesSearch: scopeMailboxId !== null && scopeMailboxId !== destination,
        update: (thread) => thread,
      });
    },
    onError: (_error, { threadIds }) =>
      showError(formatFailureCopy(verb, threadIds.length, 'conversation')),
  });
}

export function useDeleteThreadsMutation(accountId: string | null) {
  return useThreadTransferMutation<{ threadIds: string[] }>({
    accountId: accountId,
    verb: 'delete',
    mutationFn: (change) => invoke('delete_threads', { accountId: accountId as string, ...change }),
    destinationFor: () => 'TRASH',
    clearActiveSelection: true,
  });
}

export function useMoveThreadsMutation(accountId: string | null) {
  return useThreadTransferMutation<{ threadIds: string[]; destination: MoveDestination }>({
    accountId: accountId,
    verb: 'move',
    mutationFn: (change) => invoke('move_threads', { accountId: accountId as string, ...change }),
    destinationFor: (change) => change.destination,
    clearActiveSelection: false,
  });
}

export function useThreadTriageIntentMutation(accountId: string | null) {
  const labelMutation = useTriageMutation(accountId);
  const deleteMutation = useDeleteThreadsMutation(accountId);
  const moveMutation = useMoveThreadsMutation(accountId);
  return {
    isPending: labelMutation.isPending || deleteMutation.isPending || moveMutation.isPending,
    mutate: (threadIds: string[], intent: ThreadTriageIntent) => {
      if (intent.kind === 'label') {
        labelMutation.mutate({ threadIds: threadIds, add: intent.add, remove: intent.remove });
        return;
      }
      if (intent.kind === 'delete') {
        deleteMutation.mutate({ threadIds });
        return;
      }
      moveMutation.mutate({ threadIds: threadIds, destination: intent.destination });
    },
  };
}

export function useMessageTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: MessageTriageChange) =>
      invoke('mutate_messages', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadId, messageIds, add, remove }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      optimisticallyUpdateConversationMessages(queryClient, {
        accountId: accountId,
        threadId: threadId,
        messageIds: messageIds,
        removesMessage: add.includes('TRASH') || add.includes('SPAM'),
        update: (message) => applyMessageTriageChange(message, add, remove),
      });
    },
    onError: (_error, { messageIds }) =>
      showError(formatFailureCopy('update', messageIds.length, 'message')),
  });
}

function useMessageTransferMutation<Change extends { threadId: string; messageIds: string[] }>(
  accountId: string | null,
  verb: string,
  mutationFn: (change: Change) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: mutationFn,
    onMutate: async ({ threadId, messageIds }: Change) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      optimisticallyUpdateConversationMessages(queryClient, {
        accountId: accountId,
        threadId: threadId,
        messageIds: messageIds,
        removesMessage: true,
        update: (message) => message,
      });
    },
    onError: (_error, { messageIds }) =>
      showError(formatFailureCopy(verb, messageIds.length, 'message')),
  });
}

export function useDeleteMessagesMutation(accountId: string | null) {
  return useMessageTransferMutation<{ threadId: string; messageIds: string[] }>(
    accountId,
    'delete',
    (change) =>
      invoke('delete_messages', { accountId: accountId as string, messageIds: change.messageIds }),
  );
}

export function useMoveMessagesMutation(accountId: string | null) {
  return useMessageTransferMutation<{
    threadId: string;
    messageIds: string[];
    destination: MoveDestination;
  }>(accountId, 'move', (change) =>
    invoke('move_messages', {
      accountId: accountId as string,
      messageIds: change.messageIds,
      destination: change.destination,
    }),
  );
}

export function useMessageTriageIntentMutation(accountId: string | null) {
  const labelMutation = useMessageTriageMutation(accountId);
  const deleteMutation = useDeleteMessagesMutation(accountId);
  const moveMutation = useMoveMessagesMutation(accountId);
  return {
    isPending: labelMutation.isPending || deleteMutation.isPending || moveMutation.isPending,
    mutate: (threadId: string, messageIds: string[], intent: MessageTriageIntent) => {
      if (intent.kind === 'label') {
        labelMutation.mutate({
          threadId: threadId,
          messageIds: messageIds,
          add: intent.add,
          remove: intent.remove,
        });
        return;
      }
      if (intent.kind === 'delete') {
        deleteMutation.mutate({ threadId, messageIds });
        return;
      }
      moveMutation.mutate({
        threadId: threadId,
        messageIds: messageIds,
        destination: intent.destination,
      });
    },
  };
}
