import { useMemo, useSyncExternalStore } from 'react';
import { useInfiniteQuery, useMutation, useQuery, type QueryKey } from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc, dispatchInvoke } from '@/lib/ipc/dispatch';
import type {
  ImagePolicy,
  ConversationEntryScope,
  IpcCommandMap,
  PauseScope,
  SearchScope,
  ThreadCursor,
  ThreadPageParam,
} from '@/lib/types/ipc';
import { queryKeys } from './keys';
import { toLogEntry } from './mappers';
import { useToastStore } from '@/stores/toast';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import { useLayoutStore } from '@/stores/layout';
import { clearStateForRemovedAccount } from '@/lib/accounts/reset-account-state';
import { UPDATE_INTERVAL_MS } from '@/lib/update-intervals';
import { minutesToMilliseconds } from 'date-fns';

const LOCAL_FIRST_STALE_TIME = 15_000;
const LOG_AUTO_REFRESH_INTERVAL_MS = 5_000;

function useCommandMutation<Request = void, Result = unknown>(
  mutationFn: (request: Request) => Promise<Result>,
  errorMessage: string,
  onSuccess?: (result: Result, request: Request) => void,
) {
  const showError = useToastStore((toaster) => toaster.showError);
  return useMutation({
    mutationFn: mutationFn,
    onSuccess: onSuccess,
    onError: () => showError(errorMessage),
  });
}

type CursorPage = {
  nextCursor?: ThreadCursor | null;
  previousCursor?: ThreadCursor | null;
};

function nextThreadPageParam(lastPage: CursorPage): ThreadPageParam | undefined {
  return lastPage.nextCursor ? { cursor: lastPage.nextCursor, direction: 'forward' } : undefined;
}

function previousThreadPageParam(firstPage: CursorPage): ThreadPageParam | undefined {
  return firstPage.previousCursor
    ? { cursor: firstPage.previousCursor, direction: 'backward' }
    : undefined;
}

export function useAccountsQuery() {
  return useQuery({
    queryKey: queryKeys.accounts,
    queryFn: () => invoke('list_accounts', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useAiConfigsQuery() {
  return useQuery({
    queryKey: queryKeys.aiConfigs,
    queryFn: () => invoke('read_ai_configs', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useAiModelsQuery(accountId: string, revision: number, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.aiModels(accountId, revision),
    queryFn: () => invoke('list_ai_models', { accountId }),
    enabled: enabled,
    staleTime: 0,
    retry: false,
  });
}

const AI_CONNECTION_INTERVAL_MINUTES = 5;
export const AI_CONNECTION_INTERVAL_MS = minutesToMilliseconds(AI_CONNECTION_INTERVAL_MINUTES);
export const CONTACT_QUERY_MIN_LENGTH = 2;
export const RETAINED_THREAD_PAGES = 5;
const THREAD_PAGE_SIZE = 50;

function subscribeToVisibility(onChange: () => void) {
  document.addEventListener('visibilitychange', onChange);
  return () => document.removeEventListener('visibilitychange', onChange);
}

export function useWindowVisible() {
  return useSyncExternalStore(
    subscribeToVisibility,
    () => document.visibilityState === 'visible',
    () => true,
  );
}

export function useAiConnectionQuery(accountId: string, enabled = true) {
  const visible = useWindowVisible();
  return useQuery({
    queryKey: queryKeys.aiConnection(accountId),
    queryFn: () => invoke('test_ai_connection', { accountId }),
    enabled: enabled && visible,
    refetchInterval: AI_CONNECTION_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: AI_CONNECTION_INTERVAL_MS,
    retry: false,
  });
}

export function useAiIndexStatusesQuery() {
  return useQuery({
    queryKey: queryKeys.aiIndexStatuses,
    queryFn: () => invoke('read_ai_index_status', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

function useAiIndexMutation(command: 'start_ai_index' | 'cancel_ai_index' | 'rebuild_ai_index') {
  return useMutation({ mutationFn: (accountId: string) => invoke(command, { accountId }) });
}

export function useStartAiIndexMutation() {
  return useAiIndexMutation('start_ai_index');
}
export function useCancelAiIndexMutation() {
  return useAiIndexMutation('cancel_ai_index');
}
export function useRebuildAiIndexMutation() {
  return useAiIndexMutation('rebuild_ai_index');
}

export function useRemoveAccountMutation() {
  return useCommandMutation(
    (accountId: string) => invoke('remove_account', { accountId }),
    'Couldn’t remove that account.',
    (_result, accountId) => clearStateForRemovedAccount(accountId),
  );
}

export function useQueueOperationsQuery() {
  return useQuery({
    queryKey: queryKeys.queueOperations,
    queryFn: () => invoke('read_queue_operations', {}),
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useCancelQueueOperationMutation() {
  return useCommandMutation(
    (operationId: string) => invoke('cancel_queue_operation', { operationId }),
    'Couldn’t cancel that operation.',
  );
}

export function useRetryQueueOperationMutation() {
  return useCommandMutation(
    (operationId: string) => invoke('retry_queue_operation', { operationId }),
    'Couldn’t retry that operation.',
  );
}

export function useRetryFailedOperationsMutation() {
  return useCommandMutation(
    (accountId?: string) => invoke('retry_failed_operations', { accountId: accountId ?? null }),
    'Couldn’t retry the failed operations.',
  );
}

export function useClearQueueHistoryMutation() {
  return useCommandMutation(
    (accountId?: string) => invoke('clear_queue_history', { accountId: accountId ?? null }),
    'Couldn’t clear the queue history.',
  );
}

export function useSetQueuePausedMutation() {
  return useCommandMutation(
    (request: { scope: PauseScope; paused: boolean }) => invoke('set_queue_paused', request),
    'Couldn’t update the pause state.',
  );
}

export function useLogEntriesQuery() {
  return useQuery({
    queryKey: queryKeys.logEntries,
    queryFn: () => invoke('read_log_entries', {}),
    select: (entries) => entries.map(toLogEntry),
    staleTime: 0,
    refetchInterval: LOG_AUTO_REFRESH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}

export function useAppUpdateQuery() {
  const updateCheckInterval = useLayoutStore((layout) => layout.updateCheckInterval);
  return useQuery({
    queryKey: queryKeys.appUpdate,
    queryFn: () => invoke('check_for_update', {}),
    refetchInterval:
      updateCheckInterval === 'off' ? false : UPDATE_INTERVAL_MS[updateCheckInterval],
    staleTime: 0,
    retry: false,
  });
}

export function useInstallUpdateMutation() {
  return useCommandMutation<void>(
    () => invoke('install_update', {}),
    'Couldn’t install the update.',
  );
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
    queryFn: () => invoke('lookup_contacts', { accountId: accountId as string, query: query }),
    enabled: accountId !== null && query.trim().length >= CONTACT_QUERY_MIN_LENGTH,
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
        cursor: pageParam?.cursor ?? null,
        direction: pageParam?.direction ?? 'forward',
        limit: THREAD_PAGE_SIZE,
      }),
    initialPageParam: null as ThreadPageParam | null,
    getNextPageParam: nextThreadPageParam,
    getPreviousPageParam: previousThreadPageParam,
    maxPages: RETAINED_THREAD_PAGES,
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
        query: query,
        scope: scope,
        cursor: pageParam?.cursor ?? null,
        direction: pageParam?.direction ?? 'forward',
        limit: THREAD_PAGE_SIZE,
      }),
    initialPageParam: null as ThreadPageParam | null,
    getNextPageParam: nextThreadPageParam,
    getPreviousPageParam: previousThreadPageParam,
    maxPages: RETAINED_THREAD_PAGES,
    enabled: accountId !== null && query.trim().length > 0,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useSearchTotalQuery(accountId: string | null, query: string, scope: SearchScope) {
  return useQuery({
    queryKey: queryKeys.searchTotal(accountId ?? '', query, scope),
    queryFn: () =>
      invoke('search_total', { accountId: accountId as string, query: query, scope: scope }),
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

function useConversationRequest() {
  const alwaysLoad = useLayoutStore((layout) => layout.alwaysLoadRemoteImages);
  const allowedSenders = useLayoutStore((layout) => layout.allowedImageSenders);
  const loadFor = useSelectionStore((selection) => selection.imagesAllowedFor);
  const mailboxId = useSelectionStore((selection) => selection.activeMailboxId) ?? 'INBOX';
  const searchActive = useSearchStore((search) => search.active);
  const searchScope = useSearchStore((search) => search.scope);
  const imagePolicy: ImagePolicy = useMemo(
    () => ({
      alwaysLoad: alwaysLoad,
      allowedSenders: [...allowedSenders].sort(),
      loadFor: [...loadFor].sort(),
    }),
    [alwaysLoad, allowedSenders, loadFor],
  );
  const entryScope: ConversationEntryScope = searchActive
    ? { kind: 'search', scope: searchScope }
    : { kind: 'mailbox', mailboxId: mailboxId };
  return { imagePolicy, entryScope };
}

export function useConversationQuery(accountId: string | null, threadId: string | null) {
  const { imagePolicy, entryScope } = useConversationRequest();
  return useQuery({
    queryKey: queryKeys.conversation({
      accountId: accountId ?? '',
      threadId: threadId ?? '',
      policyKey: JSON.stringify(imagePolicy),
      entryScope: entryScope,
    }),
    queryFn: () =>
      invoke('load_conversation', {
        accountId: accountId as string,
        threadId: threadId as string,
        imagePolicy: imagePolicy,
        entryScope: entryScope,
      }),
    enabled: accountId !== null && threadId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useMessageBodyQuery(
  accountId: string | null,
  messageId: string | null,
  enabled = true,
) {
  const { imagePolicy, entryScope } = useConversationRequest();
  return useQuery({
    queryKey: queryKeys.messageBody({
      accountId: accountId ?? '',
      messageId: messageId ?? '',
      policyKey: JSON.stringify(imagePolicy),
      entryScope: entryScope,
    }),
    queryFn: () =>
      invoke('load_message_body', {
        accountId: accountId as string,
        messageId: messageId as string,
        imagePolicy: imagePolicy,
        entryScope: entryScope,
      }),
    enabled: enabled && accountId !== null && messageId !== null,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useMessageSourceQuery(accountId: string | null, messageId: string | null) {
  return useQuery({
    queryKey: queryKeys.messageSource(accountId ?? '', messageId ?? ''),
    queryFn: () =>
      invoke('read_message_source', {
        accountId: accountId as string,
        messageId: messageId as string,
      }),
    enabled: accountId !== null && messageId !== null,
    staleTime: Infinity,
    retry: false,
  });
}

export type AttachmentQueryInput = {
  accountId: string | null;
  messageId: string | null;
  attachmentId: string | null;
  enabled?: boolean;
};

export function useCachedAttachmentQuery({
  accountId,
  messageId,
  attachmentId,
  enabled = true,
}: AttachmentQueryInput) {
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

export function useAttachmentTextQuery({
  accountId,
  messageId,
  attachmentId,
  enabled = true,
}: AttachmentQueryInput) {
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
    gcTime: LOCAL_FIRST_STALE_TIME,
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

function useAvatarQuery<Command extends 'read_sender_avatar' | 'read_account_avatar'>({
  queryKey,
  command,
  payload,
  enabled,
}: {
  queryKey: QueryKey;
  command: Command;
  payload: IpcCommandMap[Command]['args'];
  enabled: boolean;
}) {
  return useQuery({
    queryKey: queryKey,
    queryFn: async () => {
      try {
        const result = await dispatchInvoke<string | null>(command, payload);
        return result ? dispatchConvertFileSrc(result) : null;
      } catch {
        return null;
      }
    },
    enabled: enabled,
    staleTime: LOCAL_FIRST_STALE_TIME,
  });
}

export function useSenderAvatarQuery(domain: string | null) {
  const showSenderAvatars = useLayoutStore((layout) => layout.showSenderAvatars);
  return useAvatarQuery({
    queryKey: queryKeys.senderAvatar(domain ?? ''),
    command: 'read_sender_avatar',
    payload: { domain: domain as string },
    enabled: domain !== null && showSenderAvatars,
  });
}

export function useAccountAvatarQuery(accountId: string | null) {
  return useAvatarQuery({
    queryKey: queryKeys.accountAvatar(accountId ?? ''),
    command: 'read_account_avatar',
    payload: { accountId: accountId as string },
    enabled: accountId !== null,
  });
}

export function useFetchMessageBodyMutation(accountId: string | null) {
  return useCommandMutation(
    (messageId: string) =>
      invoke('fetch_message_body', { accountId: accountId as string, messageId: messageId }),
    'Couldn’t load this message.',
  );
}
