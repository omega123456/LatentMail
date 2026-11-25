import { useMemo } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { invoke } from '@/lib/ipc/commands';
import type {
  ConversationEntryScope,
  ImagePolicy,
  SearchScope,
  ThreadPageParam,
} from '@/lib/types/ipc';
import { useLayoutStore } from '@/stores/layout';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';
import { queryKeys } from '../keys';
import {
  LOCAL_FIRST_STALE_TIME,
  nextThreadPageParam,
  previousThreadPageParam,
  RETAINED_THREAD_PAGES,
  THREAD_PAGE_SIZE,
  useCommandMutation,
} from './shared';

export const CONTACT_QUERY_MIN_LENGTH = 2;

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

export function useFetchMessageBodyMutation(accountId: string | null) {
  return useCommandMutation(
    (messageId: string) =>
      invoke('fetch_message_body', { accountId: accountId as string, messageId: messageId }),
    'Couldn’t load this message.',
  );
}
