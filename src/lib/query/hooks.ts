import { useMemo } from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc, dispatchInvoke } from '@/lib/ipc/dispatch';
import type {
  ImagePolicy,
  MoveDestination,
  PauseScope,
  SearchScope,
  ThreadCursor,
} from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { toLogEntry } from './mappers';
import { useToastStore } from '@/stores/toast';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import { useLayoutStore } from '@/stores/layout';
import { UPDATE_INTERVAL_MS } from '@/lib/update-intervals';
import type { MailThread, ThreadPage, ThreadSearchPage } from '@/lib/types/ipc';

const LOCAL_FIRST_STALE_TIME = 15_000;

export function useAccountsQuery() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => invoke('list_accounts', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useRemoveAccountMutation() {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (accountId: string) => invoke('remove_account', { accountId }),
    onSuccess: (_result, accountId) => {
      useSelectionStore.getState().clearStateForRemovedAccount(accountId);
      void queryClient.invalidateQueries({ queryKey: queryKeys.accounts });
    },
    onError: () => showError('Couldn’t remove that account.'),
  });
}

export function useQueueOperationsQuery() {
  return useQuery({
    queryKey: queryKeys.queueOperations,
    queryFn: () => invoke('read_queue_operations', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useCancelQueueOperationMutation() {
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (operationId: string) => invoke('cancel_queue_operation', { operationId }),
    onError: () => showError('Couldn’t cancel that operation.'),
  });
}

export function useRetryQueueOperationMutation() {
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (operationId: string) => invoke('retry_queue_operation', { operationId }),
    onError: () => showError('Couldn’t retry that operation.'),
  });
}

export function useRetryFailedOperationsMutation() {
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (accountId?: string) =>
      invoke('retry_failed_operations', { accountId: accountId ?? null }),
    onError: () => showError('Couldn’t retry the failed operations.'),
  });
}

export function useClearQueueHistoryMutation() {
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (accountId?: string) =>
      invoke('clear_queue_history', { accountId: accountId ?? null }),
    onError: () => showError('Couldn’t clear the queue history.'),
  });
}

export function useSetQueuePausedMutation() {
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (args: { scope: PauseScope; paused: boolean }) => invoke('set_queue_paused', args),
    onError: () => showError('Couldn’t update the pause state.'),
  });
}

export function useLogEntriesQuery() {
  return useQuery({
    queryKey: queryKeys.logEntries,
    queryFn: () => invoke('read_log_entries', {}),
    select: (entries) => entries.map(toLogEntry),
    staleTime: 0,
  });
}

export function useAppUpdateQuery() {
  const updateCheckInterval = useLayoutStore((state) => state.updateCheckInterval);
  return useQuery({
    queryKey: queryKeys.appUpdate,
    queryFn: () => invoke('check_for_update', {}),
    refetchInterval:
      updateCheckInterval === 'off' ? false : UPDATE_INTERVAL_MS[updateCheckInterval],
    staleTime: 0,
  });
}

export function useInstallUpdateMutation() {
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: () => invoke('install_update', {}),
    onError: () => showError('Couldn’t install the update.'),
  });
}

export function useLabelsQuery(accountId: string | null) {
  return useQuery({
    queryKey: queryKeys.labels(accountId ?? ''),
    queryFn: () => invoke('list_labels', { accountId: accountId as string }),
    enabled: accountId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useContactSuggestionsQuery(accountId: string | null, query: string) {
  return useQuery({
    queryKey: queryKeys.contacts(accountId ?? '', query),
    queryFn: () => invoke('lookup_contacts', { accountId: accountId as string, query }),
    enabled: accountId !== null && query.trim().length >= 2,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useThreadsQuery(accountId: string | null, mailboxId: string | null) {
  return useInfiniteQuery({
    queryKey: queryKeys.threads(accountId ?? '', mailboxId ?? ''),
    queryFn: ({ pageParam }) =>
      invoke('list_threads', {
        accountId: accountId as string,
        labelId: mailboxId,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: null as ThreadCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: accountId !== null && mailboxId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useSearchThreadsQuery(accountId: string | null, query: string, scope: SearchScope) {
  return useInfiniteQuery({
    queryKey: queryKeys.search(accountId ?? '', query, scope),
    queryFn: ({ pageParam }) =>
      invoke('search_threads', {
        accountId: accountId as string,
        query,
        scope,
        cursor: pageParam,
        limit: 50,
      }),
    initialPageParam: null as ThreadCursor | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    enabled: accountId !== null && query.trim().length > 0,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useParseSearchQueryQuery(query: string) {
  return useQuery({
    queryKey: queryKeys.parsedSearchQuery(query),
    queryFn: () => invoke('parse_search_query', { query }),
    enabled: query.trim().length > 0,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useConversationQuery(accountId: string | null, threadId: string | null) {
  const alwaysLoad = useLayoutStore((state) => state.alwaysLoadRemoteImages);
  const allowedSenders = useLayoutStore((state) => state.allowedImageSenders);
  const loadFor = useSelectionStore((state) => state.imagesAllowedFor);
  const imagePolicy: ImagePolicy = useMemo(
    () => ({
      alwaysLoad,
      allowedSenders: [...allowedSenders].sort(),
      loadFor: [...loadFor].sort(),
    }),
    [alwaysLoad, allowedSenders, loadFor],
  );
  return useQuery({
    queryKey: queryKeys.conversation(accountId ?? '', threadId ?? '', JSON.stringify(imagePolicy)),
    queryFn: () =>
      invoke('load_conversation', {
        accountId: accountId as string,
        threadId: threadId as string,
        imagePolicy,
      }),
    enabled: accountId !== null && threadId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useCachedAttachmentQuery(
  accountId: string | null,
  messageId: string | null,
  attachmentId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.cachedAttachment(accountId ?? '', messageId ?? '', attachmentId ?? ''),
    queryFn: () =>
      invoke('ensure_attachment_cached', {
        accountId: accountId as string,
        messageId: messageId as string,
        attachmentId: attachmentId as string,
      }),
    enabled: enabled && accountId !== null && messageId !== null && attachmentId !== null,
    staleTime: Infinity,
  });
}

export function useAttachmentBytesQuery(
  accountId: string | null,
  messageId: string | null,
  attachmentId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.attachmentBytes(accountId ?? '', messageId ?? '', attachmentId ?? ''),
    queryFn: () =>
      invoke('read_attachment_bytes', {
        accountId: accountId as string,
        messageId: messageId as string,
        attachmentId: attachmentId as string,
      }),
    enabled: enabled && accountId !== null && messageId !== null && attachmentId !== null,
    staleTime: Infinity,
  });
}

export function useAttachmentTextQuery(
  accountId: string | null,
  messageId: string | null,
  attachmentId: string | null,
  enabled = true,
) {
  return useQuery({
    queryKey: queryKeys.attachmentText(accountId ?? '', messageId ?? '', attachmentId ?? ''),
    queryFn: () =>
      invoke('read_attachment_text', {
        accountId: accountId as string,
        messageId: messageId as string,
        attachmentId: attachmentId as string,
      }),
    enabled: enabled && accountId !== null && messageId !== null && attachmentId !== null,
    staleTime: Infinity,
  });
}

export function useTraversalStatusQuery(accountId: string | null) {
  return useQuery({
    queryKey: queryKeys.traversalStatus(accountId ?? ''),
    queryFn: () => invoke('read_traversal_status', { accountId: accountId as string }),
    enabled: accountId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useSenderAvatarQuery(domain: string | null) {
  const showSenderAvatars = useLayoutStore((state) => state.showSenderAvatars);
  return useQuery({
    queryKey: queryKeys.senderAvatar(domain ?? ''),
    queryFn: async () => {
      try {
        const result = await dispatchInvoke<string | null>('read_sender_avatar', {
          domain: domain as string,
        });
        return result ? dispatchConvertFileSrc(result) : null;
      } catch {
        return null;
      }
    },
    enabled: domain !== null && showSenderAvatars,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useAccountAvatarQuery(accountId: string | null) {
  return useQuery({
    queryKey: queryKeys.accountAvatar(accountId ?? ''),
    queryFn: async () => {
      try {
        const result = await dispatchInvoke<string | null>('read_account_avatar', {
          accountId: accountId as string,
        });
        return result ? dispatchConvertFileSrc(result) : null;
      } catch {
        return null;
      }
    },
    enabled: accountId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useFetchMessageBodyMutation(accountId: string | null, threadId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (messageId: string) =>
      invoke('fetch_message_body', { accountId: accountId as string, messageId }),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.conversationThread(accountId ?? '', threadId ?? ''),
      }),
    onError: () => showError('Couldn’t load this message.'),
  });
}

function updateThread(
  page: ThreadPage,
  threadId: string,
  update: (thread: MailThread) => MailThread,
): ThreadPage {
  return {
    ...page,
    items: page.items.map((thread) => (thread.id === threadId ? update(thread) : thread)),
  };
}

function useLabelLifecycleMutation<TArgs>(
  accountId: string | null,
  mutationFn: (args: TArgs) => Promise<unknown>,
  copy: { done: string; failed: string },
) {
  const queryClient = useQueryClient();
  const showSuccess = useToastStore((state) => state.showSuccess);
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn,
    onSuccess: () => showSuccess(copy.done),
    onError: () => showError(copy.failed),
    onSettled: () => queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId ?? '') }),
  });
}

export function useCreateLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(
    accountId,
    (args: { name: string; colorId: string | null }) =>
      invoke('create_label', { accountId: accountId as string, ...args }),
    { done: 'Label created.', failed: 'Couldn’t create the label.' },
  );
}

export function useRenameLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(
    accountId,
    (args: { labelId: string; name: string }) =>
      invoke('rename_label', { accountId: accountId as string, ...args }),
    { done: 'Label renamed.', failed: 'Couldn’t rename the label.' },
  );
}

export function useRecolorLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(
    accountId,
    (args: { labelId: string; colorId: string }) =>
      invoke('recolor_label', { accountId: accountId as string, ...args }),
    { done: 'Label colour updated.', failed: 'Couldn’t update the colour.' },
  );
}

export function useDeleteLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(
    accountId,
    (args: { labelId: string }) =>
      invoke('delete_label', { accountId: accountId as string, ...args }),
    { done: 'Label deleted.', failed: 'Couldn’t delete the label.' },
  );
}

export function useThreadMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: async ({
      threadId,
      kind,
    }: {
      threadId: string;
      kind: 'star' | 'unstar' | 'read' | 'unread';
    }) => {
      if (!accountId) return;
      const [add, remove] =
        kind === 'star'
          ? [['STARRED'], []]
          : kind === 'unstar'
            ? [[], ['STARRED']]
            : kind === 'read'
              ? [[], ['UNREAD']]
              : [['UNREAD'], []];
      await invoke('mutate_threads', { accountId, threadIds: [threadId], add, remove });
    },
    onMutate: async ({ threadId, kind }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      const property = kind === 'star' || kind === 'unstar' ? 'isStarred' : 'isUnread';
      const value = kind === 'star' || kind === 'unread';
      queryClient.setQueriesData(
        { queryKey: queryKeys.threadsForAccount(accountId ?? '') },
        (data: { pages: ThreadPage[] } | undefined) =>
          data && {
            ...data,
            pages: data.pages.map((page) =>
              updateThread(page, threadId, (thread) => ({ ...thread, [property]: value })),
            ),
          },
      );
      return undefined;
    },
    onError: () => {
      showError('Couldn’t update conversation.');
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') }),
  });
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
          total: leavesSearch ? Math.max(0, page.total - threadIds.length) : page.total,
        })),
      },
  );
}

function virtualMailboxIdForScope(scope: SearchScope): string | null {
  if (scope.kind === 'default') return 'INBOX';
  if (scope.kind === 'all') return null;
  return scope.labelId;
}

export function useTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
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
      });
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
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversationsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.searchForAccount(accountId ?? '') });
      useMultiSelectStore.getState().clear();
    },
  });
}

export function useDeleteThreadsMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (change: { threadIds: string[] }) =>
      invoke('delete_threads', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadIds }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      await queryClient.cancelQueries({ queryKey: queryKeys.searchForAccount(accountId ?? '') });
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
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversationsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.searchForAccount(accountId ?? '') });
      useMultiSelectStore.getState().clear();
    },
  });
}

export function useMoveThreadsMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
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
    onSettled: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversationsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.searchForAccount(accountId ?? '') });
      useMultiSelectStore.getState().clear();
    },
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
        labelMutation.mutate({ threadIds, add: intent.add, remove: intent.remove });
      else if (intent.kind === 'delete') deleteMutation.mutate({ threadIds });
      else moveMutation.mutate({ threadIds, destination: intent.destination });
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
  messageIds: string[],
  removesMessage: boolean,
  update: (message: ReaderMessageCacheEntry) => ReaderMessageCacheEntry,
) {
  queryClient.setQueriesData(
    { queryKey: queryKeys.conversationThread(accountId ?? '', threadId) },
    (data: { messages: ReaderMessageCacheEntry[] } | undefined) =>
      data && {
        ...data,
        messages: data.messages
          .filter((message) => !(removesMessage && messageIds.includes(message.id)))
          .map((message) => (messageIds.includes(message.id) ? update(message) : message)),
      },
  );
}

export function useMessageTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
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
    onSettled: (_result, _error, { threadId }) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversationThread(accountId ?? '', threadId),
      });
    },
  });
}

export function useDeleteMessagesMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
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
    onSettled: (_result, _error, { threadId }) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversationThread(accountId ?? '', threadId),
      });
    },
  });
}

export function useMoveMessagesMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
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
    onSettled: (_result, _error, { threadId }) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.threadsForAccount(accountId ?? ''),
      });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.conversationThread(accountId ?? '', threadId),
      });
    },
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
        labelMutation.mutate({ threadId, messageIds, add: intent.add, remove: intent.remove });
      else if (intent.kind === 'delete') deleteMutation.mutate({ threadId, messageIds });
      else moveMutation.mutate({ threadId, messageIds, destination: intent.destination });
    },
  };
}
