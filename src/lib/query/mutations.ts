import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import type {
  MailLabel,
  MailLabelColor,
  MailThread,
  MoveDestination,
  SearchScope,
  ThreadPage,
  ThreadSearchPage,
} from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import { LABEL_COLOR_BY_ID } from '@/lib/labels/palette';
import { compareLabelNames } from '@/lib/labels/order';
import { formatCount } from '@/lib/format/strings';

function useLabelLifecycleMutation<Request>(
  accountId: string | null,
  mutationFn: (request: Request) => Promise<unknown>,
  copy: { done: string; failed: string },
  optimistic: (labels: MailLabel[], request: Request) => MailLabel[],
) {
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

function labelColorFor(colorId: string | null): MailLabelColor | null {
  const swatch = colorId === null ? undefined : LABEL_COLOR_BY_ID[colorId];
  return swatch ? { background: swatch.gmailBackground, text: swatch.gmailText } : null;
}

export function useCreateLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(
    accountId,
    (request: { name: string; colorId: string | null }) =>
      invoke('create_label', { accountId: accountId as string, ...request }),
    { done: 'Label created.', failed: 'Couldn’t create the label.' },
    (labels, request) =>
      [
        ...labels,
        {
          id: `pending-label-${request.name}`,
          name: request.name,
          kind: 'user',
          color: labelColorFor(request.colorId),
          messageCount: 0,
          unreadCount: 0,
        },
      ].sort(compareLabelNames),
  );
}

export function useRenameLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(
    accountId,
    (request: { labelId: string; name: string }) =>
      invoke('rename_label', { accountId: accountId as string, ...request }),
    { done: 'Label renamed.', failed: 'Couldn’t rename the label.' },
    (labels, request) =>
      labels
        .map((label) => (label.id === request.labelId ? { ...label, name: request.name } : label))
        .sort(compareLabelNames),
  );
}

export function useRecolorLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(
    accountId,
    (request: { labelId: string; colorId: string }) =>
      invoke('recolor_label', { accountId: accountId as string, ...request }),
    { done: 'Label colour updated.', failed: 'Couldn’t update the colour.' },
    (labels, request) =>
      labels.map((label) =>
        label.id === request.labelId ? { ...label, color: labelColorFor(request.colorId) } : label,
      ),
  );
}

export function useDeleteLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(
    accountId,
    (request: { labelId: string }) =>
      invoke('delete_label', { accountId: accountId as string, ...request }),
    { done: 'Label deleted.', failed: 'Couldn’t delete the label.' },
    (labels, request) => labels.filter((label) => label.id !== request.labelId),
  );
}

export type TriageChange = { threadIds: string[]; add: string[]; remove: string[] };
export type MessageTriageChange = {
  threadId: string;
  messageIds: string[];
  add: string[];
  remove: string[];
};

export type TriageIntent =
  | { kind: 'label'; add: string[]; remove: string[] }
  | { kind: 'delete' }
  | { kind: 'move'; destination: MoveDestination };

export type ThreadTriageIntent = TriageIntent;
export type MessageTriageIntent = TriageIntent;

function formatFailureCopy(verb: string, count: number, singular: string): string {
  if (count > 1) return `Couldn’t ${verb} ${formatCount(count, singular)}.`;
  return `Couldn’t ${verb} ${singular}.`;
}

function optimisticallyUpdatePages<Page extends ThreadPage | ThreadSearchPage>(
  queryClient: ReturnType<typeof useQueryClient>,
  queryKey: QueryKey,
  threadIds: string[],
  removesMatching: boolean,
  update: (thread: MailThread) => MailThread,
) {
  queryClient.setQueriesData(
    { queryKey: queryKey },
    (data: { pages: Page[] } | undefined) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items
            .filter((thread) => !(removesMatching && threadIds.includes(thread.id)))
            .map((thread) => (threadIds.includes(thread.id) ? update(thread) : thread)),
        })),
      },
  );
}

function optimisticallyUpdateThreadAndSearchPages(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string | null,
  threadIds: string[],
  leavesMailbox: boolean,
  leavesSearch: boolean,
  update: (thread: MailThread) => MailThread,
) {
  const accountKey = accountId ?? '';
  optimisticallyUpdatePages<ThreadPage>(
    queryClient,
    queryKeys.threadsForAccount(accountKey),
    threadIds,
    leavesMailbox,
    update,
  );
  optimisticallyUpdatePages<ThreadSearchPage>(
    queryClient,
    queryKeys.searchForAccount(accountKey),
    threadIds,
    leavesSearch,
    update,
  );
  if (leavesSearch) {
    queryClient.setQueriesData<number>(
      { queryKey: queryKeys.searchTotalsForAccount(accountKey) },
      (total) => (total === undefined ? total : Math.max(0, total - threadIds.length)),
    );
  }
}

function virtualMailboxIdForScope(scope: SearchScope): string | null {
  if (scope.kind === 'default') return 'INBOX';
  if (scope.kind === 'all') return null;
  return scope.labelId;
}

function leavesMailboxForLabelChange(
  mailboxId: string | null,
  add: string[],
  remove: string[],
): boolean {
  if (mailboxId === null) return false;
  if (remove.includes(mailboxId)) return true;
  return mailboxId === 'INBOX' && (add.includes('TRASH') || add.includes('SPAM'));
}

function resolveFlagChange(
  flagLabel: string,
  add: string[],
  remove: string[],
  current: boolean,
): boolean {
  if (add.includes(flagLabel)) return true;
  if (remove.includes(flagLabel)) return false;
  return current;
}

async function cancelThreadAndSearchQueries(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string | null,
) {
  const accountKey = accountId ?? '';
  await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountKey) });
  await queryClient.cancelQueries({ queryKey: queryKeys.searchForAccount(accountKey) });
}

export function useTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: TriageChange) =>
      invoke('mutate_threads', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadIds, add, remove }) => {
      await cancelThreadAndSearchQueries(queryClient, accountId);
      const mailboxId = useSelectionStore.getState().activeMailboxId;
      const leavesMailbox = leavesMailboxForLabelChange(mailboxId, add, remove);
      const userLabelNames = new Map(
        (queryClient.getQueryData<MailLabel[]>(queryKeys.labels(accountId ?? '')) ?? [])
          .filter((label) => label.kind === 'user')
          .map((label) => [label.id, label.name] as const),
      );
      const addedNames = add
        .map((labelId) => userLabelNames.get(labelId))
        .filter((name): name is string => name !== undefined);
      const removedNames = new Set(remove.map((labelId) => userLabelNames.get(labelId)));
      const update = (thread: MailThread) => ({
        ...thread,
        isStarred: resolveFlagChange('STARRED', add, remove, thread.isStarred),
        isUnread: resolveFlagChange('UNREAD', add, remove, thread.isUnread),
        labelIndicators: [
          ...new Set([
            ...(thread.labelIndicators ?? []).filter((name) => !removedNames.has(name)),
            ...addedNames,
          ]),
        ].sort(),
      });
      for (const threadId of threadIds) {
        optimisticallyUpdateConversationMessages(
          queryClient,
          accountId,
          threadId,
          null,
          false,
          (message) => ({
            ...message,
            labelIds: [
              ...new Set([...message.labelIds.filter((id) => !remove.includes(id)), ...add]),
            ],
          }),
        );
      }
      const scopeMailboxId = virtualMailboxIdForScope(useSearchStore.getState().scope);
      const leavesSearch = leavesMailboxForLabelChange(scopeMailboxId, add, remove);
      optimisticallyUpdateThreadAndSearchPages(
        queryClient,
        accountId,
        threadIds,
        leavesMailbox,
        leavesSearch,
        update,
      );
    },
    onError: (_error, { threadIds }) =>
      showError(formatFailureCopy('update', threadIds.length, 'conversation')),
  });
}

function useThreadTransferMutation<Change extends { threadIds: string[] }>(
  accountId: string | null,
  verb: string,
  mutationFn: (change: Change) => Promise<unknown>,
  destinationFor: (change: Change) => string,
  clearActiveSelection: boolean,
) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: mutationFn,
    onMutate: async (change: Change) => {
      await cancelThreadAndSearchQueries(queryClient, accountId);
      if (
        clearActiveSelection &&
        change.threadIds.includes(useSelectionStore.getState().activeThreadId ?? '')
      ) {
        useSelectionStore.getState().clearSelection();
      }
      const destination = destinationFor(change);
      const mailboxId = useSelectionStore.getState().activeMailboxId;
      const leavesMailbox = mailboxId !== destination;
      const scopeMailboxId = virtualMailboxIdForScope(useSearchStore.getState().scope);
      const leavesSearch = scopeMailboxId !== null && scopeMailboxId !== destination;
      optimisticallyUpdateThreadAndSearchPages(
        queryClient,
        accountId,
        change.threadIds,
        leavesMailbox,
        leavesSearch,
        (thread) => thread,
      );
    },
    onError: (_error, { threadIds }) =>
      showError(formatFailureCopy(verb, threadIds.length, 'conversation')),
  });
}

export function useDeleteThreadsMutation(accountId: string | null) {
  return useThreadTransferMutation<{ threadIds: string[] }>(
    accountId,
    'delete',
    (change) => invoke('delete_threads', { accountId: accountId as string, ...change }),
    () => 'TRASH',
    true,
  );
}

export function useMoveThreadsMutation(accountId: string | null) {
  return useThreadTransferMutation<{ threadIds: string[]; destination: MoveDestination }>(
    accountId,
    'move',
    (change) => invoke('move_threads', { accountId: accountId as string, ...change }),
    (change) => change.destination,
    false,
  );
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

type ReaderMessageCacheEntry = {
  id: string;
  labelIds: string[];
  isUnread: boolean;
  isStarred: boolean;
};

function optimisticallyUpdateConversationMessages(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string | null,
  threadId: string,
  messageIds: string[] | null,
  removesMessage: boolean,
  update: (message: ReaderMessageCacheEntry) => ReaderMessageCacheEntry,
) {
  const targeted = (messageId: string) => messageIds === null || messageIds.includes(messageId);
  queryClient.setQueriesData(
    { queryKey: queryKeys.conversationThread(accountId ?? '', threadId) },
    (data: { messages: ReaderMessageCacheEntry[] } | undefined) =>
      data && {
        ...data,
        messages: data.messages
          .filter((message) => !(removesMessage && targeted(message.id)))
          .map((message) => (targeted(message.id) ? update(message) : message)),
      },
  );
}

export function useMessageTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: MessageTriageChange) =>
      invoke('mutate_messages', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadId, messageIds, add, remove }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      optimisticallyUpdateConversationMessages(
        queryClient,
        accountId,
        threadId,
        messageIds,
        add.includes('TRASH') || add.includes('SPAM'),
        (message) => ({
          ...message,
          isUnread: resolveFlagChange('UNREAD', add, remove, message.isUnread),
          isStarred: resolveFlagChange('STARRED', add, remove, message.isStarred),
          labelIds: [
            ...new Set([...message.labelIds.filter((id) => !remove.includes(id)), ...add]),
          ],
        }),
      );
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
      optimisticallyUpdateConversationMessages(
        queryClient,
        accountId,
        threadId,
        messageIds,
        true,
        (message) => message,
      );
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
