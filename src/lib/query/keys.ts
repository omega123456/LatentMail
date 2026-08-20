import type { SearchScope } from '@/lib/types/ipc';

export const queryKeys = {
  accounts: ['accounts'] as const,
  labels: (accountId: string) => ['labels', accountId] as const,
  contacts: (accountId: string, query: string) => ['contacts', accountId, query] as const,
  threads: (accountId: string, mailboxId: string) => ['threads', accountId, mailboxId] as const,
  threadsForAccount: (accountId: string) => ['threads', accountId] as const,
  search: (accountId: string, query: string, scope: SearchScope) =>
    ['search', accountId, query, JSON.stringify(scope)] as const,
  searchForAccount: (accountId: string) => ['search', accountId] as const,
  parsedSearchQuery: (query: string) => ['parsedSearchQuery', query] as const,
  conversation: (accountId: string, threadId: string, policyKey: string) =>
    ['conversation', accountId, threadId, policyKey] as const,
  conversationThread: (accountId: string, threadId: string) =>
    ['conversation', accountId, threadId] as const,
  conversationsForAccount: (accountId: string) => ['conversation', accountId] as const,
  syncStatus: (accountId: string) => ['syncStatus', accountId] as const,
  traversalStatus: (accountId: string) => ['traversalStatus', accountId] as const,
  senderAvatar: (domain: string) => ['senderAvatar', domain] as const,
  accountAvatar: (accountId: string) => ['accountAvatar', accountId] as const,
  queueOperations: ['queueOperations'] as const,
  logEntries: ['logEntries'] as const,
  appUpdate: ['appUpdate'] as const,
  cachedAttachment: (accountId: string, messageId: string, attachmentId: string) =>
    ['cachedAttachment', accountId, messageId, attachmentId] as const,
  attachmentBytes: (accountId: string, messageId: string, attachmentId: string) =>
    ['attachmentBytes', accountId, messageId, attachmentId] as const,
  attachmentText: (accountId: string, messageId: string, attachmentId: string) =>
    ['attachmentText', accountId, messageId, attachmentId] as const,
};
