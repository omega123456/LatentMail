import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc, dispatchInvoke } from '@/lib/ipc/dispatch';
import type { ThreadCursor } from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { useToastStore } from '@/stores/toast';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { useLayoutStore } from '@/stores/layout';
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

/** Cache-first sender-avatar lookup, keyed by domain (D-series: addresses
 * sharing a domain collapse onto one query). Gated on `showSenderAvatars` —
 * `enabled: false` means the query function never runs and no lookup is
 * issued, which is the privacy guarantee (D14), not just an ignored result.
 * A rejected invoke (the command is unregistered until Phase 1 lands, and
 * any future capability mistype produces the same rejection) is treated
 * identically to "no image": swallowed inside `queryFn`, never surfaced as
 * an error state. Uses `dispatchInvoke` directly rather than
 * `@/lib/ipc/commands`'s `invoke` — that wrapper logs every rejection
 * through `appLog.error` (a real `console.error`), which a routine, expected
 * "not registered yet" rejection must never produce (mirrors `app-log.ts`'s
 * own reason for bypassing it). */
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

/** Cache-first account profile-photo lookup. Not gated by
 * `showSenderAvatars` — the account photograph involves no third-party
 * lookup (FR "Preference"). Same silent-degrade-on-rejection contract as
 * `useSenderAvatarQuery` above. */
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
        queryKey: queryKeys.conversation(accountId ?? '', threadId ?? ''),
      }),
    // The reader shows a body-shaped hole on failure with nothing to explain
    // it, so this is the only place the user learns the fetch went wrong.
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

/** Label lifecycle mutations (create/rename/recolour/delete) — the four
 * label-management IPC calls this phase owns end-to-end (unlike triage
 * mutations over `mutate_threads`, left for Phase 8). No optimistic overlay:
 * per D7, on permanent failure the caller sees the mutation reject and the
 * settled invalidation below refetches server-confirmed state — there's
 * nothing to roll back because nothing was applied ahead of the response.
 * `LabelList` calls these through `.mutateAsync` and surfaces a rejection's
 * `message` inline, matching the Rust-side `LabelNameError` text.
 *
 * A toast rides alongside that inline message rather than replacing it: the
 * label row is a small target in a scrolling sidebar and its inline error is
 * easy to miss, unlike the compose footer or an attachment chip the user is
 * looking straight at when those fail. */
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
      const leavesMailbox =
        mailboxId !== null &&
        (remove.includes(mailboxId) ||
          (mailboxId === 'INBOX' && add.includes('TRASH')) ||
          (mailboxId === 'INBOX' && add.includes('SPAM')));
      queryClient.setQueriesData(
        { queryKey: queryKeys.threadsForAccount(accountId ?? '') },
        (data: { pages: ThreadPage[] } | undefined) =>
          data && {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              items: page.items
                .filter((thread) => !(leavesMailbox && threadIds.includes(thread.id)))
                .map((thread) =>
                  threadIds.includes(thread.id)
                    ? {
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
                      }
                    : thread,
                ),
            })),
          },
      );
    },
    // One toast for the whole change, not one per thread: a bulk triage over a
    // selection fails as a single `mutate_threads` call, and reporting it
    // per-thread would flood the viewport and blow past its cap.
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
      useMultiSelectStore.getState().clear();
    },
  });
}

export function useMessageTriageMutation(accountId: string | null) {
  const queryClient = useQueryClient();
  const showError = useToastStore((state) => state.showError);
  return useMutation({
    mutationFn: (change: MessageTriageChange) =>
      invoke('mutate_messages', { accountId: accountId as string, ...change }),
    onMutate: async ({ threadId, messageIds, add, remove }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.threadsForAccount(accountId ?? '') });
      queryClient.setQueriesData(
        { queryKey: queryKeys.conversation(accountId ?? '', threadId) },
        (
          data:
            | {
                messages: Array<{
                  id: string;
                  labelIds: string[];
                  isUnread: boolean;
                  isStarred: boolean;
                }>;
              }
            | undefined,
        ) =>
          data && {
            ...data,
            messages: data.messages
              .filter(
                (message) =>
                  !(add.includes('TRASH') || add.includes('SPAM')) ||
                  !messageIds.includes(message.id),
              )
              .map((message) =>
                messageIds.includes(message.id)
                  ? {
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
                        ...new Set([
                          ...message.labelIds.filter((id) => !remove.includes(id)),
                          ...add,
                        ]),
                      ],
                    }
                  : message,
              ),
          },
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
        queryKey: queryKeys.conversation(accountId ?? '', threadId),
      });
    },
  });
}
