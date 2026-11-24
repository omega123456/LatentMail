import { useMutation, useQueryClient } from '@tanstack/react-query';
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

function useLabelLifecycleMutation<TArgs>(
  accountId: string | null,
  mutationFn: (request: TArgs) => Promise<unknown>,
  copy: { done: string; failed: string },
  optimistic: (labels: MailLabel[], request: TArgs) => MailLabel[],
) {
  const queryClient = useQueryClient();
  const showSuccess = useToastStore((toaster) => toaster.showSuccess);
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: mutationFn,
    onMutate: async (request: TArgs) => {
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

export type ThreadTriageIntent =
  | { kind: 'label'; add: string[]; remove: string[] }
  | { kind: 'delete' }
  | { kind: 'move'; destination: MoveDestination };

export type MessageTriageIntent =
  | { kind: 'label'; add: string[]; remove: string[] }
  | { kind: 'delete' }
  | { kind: 'move'; destination: MoveDestination };

function optimisticallyUpdateThreadPages(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string | null,
  threadIds: string[],
  leavesMailbox: boolean,
  update: (thread: MailThread) => MailThread,
) {
  queryClient.setQueriesData(
    { queryKey: queryKeys.threadsForAccount(accountId ?? '') },
    (data: { pages: ThreadPage[] } | undefined) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items
            .filter((thread) => !(leavesMailbox && threadIds.includes(thread.id)))
            .map((thread) => (threadIds.includes(thread.id) ? update(thread) : thread)),
        })),
      },
  );
}

function optimisticallyUpdateSearchPages(
  queryClient: ReturnType<typeof useQueryClient>,
  accountId: string | null,
  threadIds: string[],
  leavesSearch: boolean,
  update: (thread: MailThread) => MailThread,
) {
  queryClient.setQueriesData(
    { queryKey: queryKeys.searchForAccount(accountId ?? '') },
    (data: { pages: ThreadSearchPage[] } | undefined) =>
      data && {
        ...data,
        pages: data.pages.map((page) => ({
          ...page,
          items: page.items
            .filter((thread) => !(leavesSearch && threadIds.includes(thread.id)))
            .map((thread) => (threadIds.includes(thread.id) ? update(thread) : thread)),
        })),
      },
  );
  if (leavesSearch)
    queryClient.setQueriesData<number>(
      { queryKey: queryKeys.searchTotalsForAccount(accountId ?? '') },
      (total) => (total === undefined ? total : Math.max(0, total - threadIds.length)),
    );
}

function virtualMailboxIdForScope(scope: SearchScope): string | null {
  if (scope.kind === 'default') return 'INBOX';
  if (scope.kind === 'all') return null;
  return scope.labelId;
}

export function useTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: TriageChange) =>
      invoke('mutate_threads', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadIds, add, remove }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      await queryClient.cancelQueries({ queryKey: queryKeys.searchForAccount(accountId ?? '') });
      const mailboxId = useSelectionStore.getState().activeMailboxId;
      const leavesMailbox =
        mailboxId !== null &&
        (remove.includes(mailboxId) ||
          (mailboxId === 'INBOX' && add.includes('TRASH')) ||
          (mailboxId === 'INBOX' && add.includes('SPAM')));
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
        isStarred: add.includes('STARRED')
          ? true
          : remove.includes('STARRED')
            ? false
            : thread.isStarred,
        isUnread: add.includes('UNREAD')
          ? true
          : remove.includes('UNREAD')
            ? false
            : thread.isUnread,
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
      optimisticallyUpdateThreadPages(queryClient, accountId, threadIds, leavesMailbox, update);
      const scopeMailboxId = virtualMailboxIdForScope(useSearchStore.getState().scope);
      const leavesSearch =
        scopeMailboxId !== null &&
        (remove.includes(scopeMailboxId) ||
          (scopeMailboxId === 'INBOX' && add.includes('TRASH')) ||
          (scopeMailboxId === 'INBOX' && add.includes('SPAM')));
      optimisticallyUpdateSearchPages(queryClient, accountId, threadIds, leavesSearch, update);
    },
    onError: (_error, { threadIds }) =>
      showError(
        threadIds.length > 1
          ? `Couldn’t update ${threadIds.length} conversations.`
          : 'Couldn’t update conversation.',
      ),
  });
}

export function useDeleteThreadsMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: { threadIds: string[] }) =>
      invoke('delete_threads', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadIds }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      await queryClient.cancelQueries({ queryKey: queryKeys.searchForAccount(accountId ?? '') });
      if (threadIds.includes(useSelectionStore.getState().activeThreadId ?? ''))
        useSelectionStore.getState().clearSelection();
      const mailboxId = useSelectionStore.getState().activeMailboxId;
      const leavesMailbox = mailboxId !== 'TRASH';
      optimisticallyUpdateThreadPages(
        queryClient,
        accountId,
        threadIds,
        leavesMailbox,
        (thread) => thread,
      );
      const scopeMailboxId = virtualMailboxIdForScope(useSearchStore.getState().scope);
      const leavesSearch = scopeMailboxId !== null && scopeMailboxId !== 'TRASH';
      optimisticallyUpdateSearchPages(
        queryClient,
        accountId,
        threadIds,
        leavesSearch,
        (thread) => thread,
      );
    },
    onError: (_error, { threadIds }) =>
      showError(
        threadIds.length > 1
          ? `Couldn’t delete ${threadIds.length} conversations.`
          : 'Couldn’t delete conversation.',
      ),
  });
}

export function useMoveThreadsMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: { threadIds: string[]; destination: MoveDestination }) =>
      invoke('move_threads', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadIds, destination }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      await queryClient.cancelQueries({ queryKey: queryKeys.searchForAccount(accountId ?? '') });
      const mailboxId = useSelectionStore.getState().activeMailboxId;
      const leavesMailbox = mailboxId !== destination;
      optimisticallyUpdateThreadPages(
        queryClient,
        accountId,
        threadIds,
        leavesMailbox,
        (thread) => thread,
      );
      const scopeMailboxId = virtualMailboxIdForScope(useSearchStore.getState().scope);
      const leavesSearch = scopeMailboxId !== null && scopeMailboxId !== destination;
      optimisticallyUpdateSearchPages(
        queryClient,
        accountId,
        threadIds,
        leavesSearch,
        (thread) => thread,
      );
    },
    onError: (_error, { threadIds }) =>
      showError(
        threadIds.length > 1
          ? `Couldn’t move ${threadIds.length} conversations.`
          : 'Couldn’t move conversation.',
      ),
  });
}

export function useThreadTriageIntentMutation(accountId: string | null) {
  const labelMutation = useTriageMutation(accountId);
  const deleteMutation = useDeleteThreadsMutation(accountId);
  const moveMutation = useMoveThreadsMutation(accountId);
  return {
    isPending: labelMutation.isPending || deleteMutation.isPending || moveMutation.isPending,
    mutate: (threadIds: string[], intent: ThreadTriageIntent) => {
      if (intent.kind === 'label')
        labelMutation.mutate({ threadIds: threadIds, add: intent.add, remove: intent.remove });
      else if (intent.kind === 'delete') deleteMutation.mutate({ threadIds });
      else moveMutation.mutate({ threadIds: threadIds, destination: intent.destination });
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
          isUnread: add.includes('UNREAD')
            ? true
            : remove.includes('UNREAD')
              ? false
              : message.isUnread,
          isStarred: add.includes('STARRED')
            ? true
            : remove.includes('STARRED')
              ? false
              : message.isStarred,
          labelIds: [
            ...new Set([...message.labelIds.filter((id) => !remove.includes(id)), ...add]),
          ],
        }),
      );
    },
    onError: (_error, { messageIds }) =>
      showError(
        messageIds.length > 1
          ? `Couldn’t update ${messageIds.length} messages.`
          : 'Couldn’t update message.',
      ),
  });
}

export function useDeleteMessagesMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: { threadId: string; messageIds: string[] }) =>
      invoke('delete_messages', { accountId: accountId as string, messageIds: change.messageIds }),
    onMutate: async ({ threadId, messageIds }) => {
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
      showError(
        messageIds.length > 1
          ? `Couldn’t delete ${messageIds.length} messages.`
          : 'Couldn’t delete message.',
      ),
  });
}

export function useMoveMessagesMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: (change: {
      threadId: string;
      messageIds: string[];
      destination: MoveDestination;
    }) =>
      invoke('move_messages', {
        accountId: accountId as string,
        messageIds: change.messageIds,
        destination: change.destination,
      }),
    onMutate: async ({ threadId, messageIds }) => {
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
      showError(
        messageIds.length > 1
          ? `Couldn’t move ${messageIds.length} messages.`
          : 'Couldn’t move message.',
      ),
  });
}

export function useMessageTriageIntentMutation(accountId: string | null) {
  const labelMutation = useMessageTriageMutation(accountId);
  const deleteMutation = useDeleteMessagesMutation(accountId);
  const moveMutation = useMoveMessagesMutation(accountId);
  return {
    isPending: labelMutation.isPending || deleteMutation.isPending || moveMutation.isPending,
    mutate: (threadId: string, messageIds: string[], intent: MessageTriageIntent) => {
      if (intent.kind === 'label')
        labelMutation.mutate({
          threadId: threadId,
          messageIds: messageIds,
          add: intent.add,
          remove: intent.remove,
        });
      else if (intent.kind === 'delete') deleteMutation.mutate({ threadId, messageIds });
      else
        moveMutation.mutate({
          threadId: threadId,
          messageIds: messageIds,
          destination: intent.destination,
        });
    },
  };
}
