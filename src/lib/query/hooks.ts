import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import type { ThreadCursor } from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import type { MailThread, ThreadPage } from '@/lib/types/ipc';

// Rust already renders from SQLite immediately and reconciles after network
// (local-first, D-series decision) — a short staleTime avoids fighting that
// by refetching aggressively on every mount/focus.
const LOCAL_FIRST_STALE_TIME = 15_000;

export function useAccountsQuery() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => invoke('list_accounts', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
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

export function useConversationQuery(accountId: string | null, threadId: string | null) {
  return useQuery({
    queryKey: queryKeys.conversation(accountId ?? '', threadId ?? ''),
    queryFn: () =>
      invoke('load_conversation', { accountId: accountId as string, threadId: threadId as string }),
    enabled: accountId !== null && threadId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
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

export function useFetchMessageBodyMutation(accountId: string | null, threadId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (messageId: string) =>
      invoke('fetch_message_body', { accountId: accountId as string, messageId }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.conversation(accountId ?? '', threadId ?? '') }),
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

/** Label lifecycle mutations (create/rename/recolour/delete) — the four
 * label-management IPC calls this phase owns end-to-end (unlike triage
 * mutations over `mutate_threads`, left for Phase 8). No optimistic overlay:
 * per D7, on permanent failure the caller sees the mutation reject and the
 * settled invalidation below refetches server-confirmed state — there's
 * nothing to roll back because nothing was applied ahead of the response.
 * `LabelList` calls these through `.mutateAsync` and surfaces a rejection's
 * `message` inline, matching the Rust-side `LabelNameError` text. */
function useLabelLifecycleMutation<TArgs>(
  accountId: string | null,
  mutationFn: (args: TArgs) => Promise<unknown>,
) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.labels(accountId ?? '') }),
  });
}

export function useCreateLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(accountId, (args: { name: string; colorId: string | null }) =>
    invoke('create_label', { accountId: accountId as string, ...args }),
  );
}

export function useRenameLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(accountId, (args: { labelId: string; name: string }) =>
    invoke('rename_label', { accountId: accountId as string, ...args }),
  );
}

export function useRecolorLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(accountId, (args: { labelId: string; colorId: string }) =>
    invoke('recolor_label', { accountId: accountId as string, ...args }),
  );
}

export function useDeleteLabelMutation(accountId: string | null) {
  return useLabelLifecycleMutation(accountId, (args: { labelId: string }) =>
    invoke('delete_label', { accountId: accountId as string, ...args }),
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
      const [add, remove] = kind === 'star' ? [['STARRED'], []] : kind === 'unstar' ? [[], ['STARRED']] : kind === 'read' ? [[], ['UNREAD']] : [['UNREAD'], []];
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
      showError('Couldn’t update conversation. Please try again.');
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') }),
  });
}

export type TriageChange = { threadIds: string[]; add: string[]; remove: string[] };
export type MessageTriageChange = { threadId: string; messageIds: string[]; add: string[]; remove: string[] };

/** The single optimistic triage path. Confirmation and rollback both read
 * SQLite again; snapshots are invalid under coalescing. */
export function useTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (change: TriageChange) =>
      invoke('mutate_threads', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadIds, add, remove }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      const mailboxId = useSelectionStore.getState().activeMailboxId;
      const leavesMailbox = mailboxId !== null && (remove.includes(mailboxId) || (mailboxId === 'INBOX' && add.includes('TRASH')) || (mailboxId === 'INBOX' && add.includes('SPAM')));
      queryClient.setQueriesData(
        { queryKey: queryKeys.threadsForAccount(accountId ?? '') },
        (data: { pages: ThreadPage[] } | undefined) => data && ({
          ...data,
          pages: data.pages.map((page) => ({ ...page, items: page.items.filter((thread) => !(leavesMailbox && threadIds.includes(thread.id))).map((thread) =>
            threadIds.includes(thread.id) ? { ...thread,
              isStarred: add.includes('STARRED') ? true : remove.includes('STARRED') ? false : thread.isStarred,
              isUnread: add.includes('UNREAD') ? true : remove.includes('UNREAD') ? false : thread.isUnread,
            } : thread) })),
        }),
      );
    },
    onError: () => showError('Couldn’t update conversation. Please try again.'),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversationsForAccount(accountId ?? '') });
      useMultiSelectStore.getState().clear();
    },
  });
}

export function useMessageTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (change: MessageTriageChange) => invoke('mutate_messages', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadId, messageIds, add, remove }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      queryClient.setQueriesData(
        { queryKey: queryKeys.conversation(accountId ?? '', threadId) },
        (data: { messages: Array<{ id: string; labelIds: string[]; isUnread: boolean; isStarred: boolean }> } | undefined) =>
          data && ({
            ...data,
            messages: data.messages.filter((message) => !(add.includes('TRASH') || add.includes('SPAM')) || !messageIds.includes(message.id)).map((message) =>
              messageIds.includes(message.id)
                ? {
                    ...message,
                    isUnread: add.includes('UNREAD') ? true : remove.includes('UNREAD') ? false : message.isUnread,
                    isStarred: add.includes('STARRED') ? true : remove.includes('STARRED') ? false : message.isStarred,
                    labelIds: [...new Set([...message.labelIds.filter((id) => !remove.includes(id)), ...add])],
                  }
                : message,
            ),
          }),
      );
    },
    onError: () => showError('Couldn’t update message. Please try again.'),
    onSettled: (_result, _error, { threadId }) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      void queryClient.invalidateQueries({ queryKey: queryKeys.conversation(accountId ?? '', threadId) });
    },
  });
}
