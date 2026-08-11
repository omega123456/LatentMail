import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import type { ThreadCursor } from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
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
      const command = {
        star: 'star_thread',
        unstar: 'unstar_thread',
        read: 'mark_thread_read',
        unread: 'mark_thread_unread',
      } as const;
      await invoke(command[kind], { accountId, threadId });
    },
    onMutate: async ({ threadId, kind }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      const previous = queryClient.getQueriesData({
        queryKey: queryKeys.threadsForAccount(accountId ?? ''),
      });
      const property = kind === 'star' || kind === 'unstar' ? 'isStarred' : 'isUnread';
      const value = kind === 'star' || kind === 'read';
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
      return { previous };
    },
    onError: (_error, _variables, context) => {
      context?.previous.forEach(([key, data]) => queryClient.setQueryData(key, data));
      showError('Couldn’t update conversation. Please try again.');
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') }),
  });
}
