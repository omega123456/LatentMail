/** Central TanStack Query key registry. Every hook in `hooks.ts` and every
 * invalidation in `event-bridge.ts` must build keys through these factories
 * so array-prefix invalidation (`invalidateQueries({ queryKey })`) reaches
 * every dependent query without hand-maintained duplication. */
export const queryKeys = {
  accounts: ['accounts'] as const,
  labels: (accountId: string) => ['labels', accountId] as const,
  threads: (accountId: string, mailboxId: string) => ['threads', accountId, mailboxId] as const,
  threadsForAccount: (accountId: string) => ['threads', accountId] as const,
  conversation: (accountId: string, threadId: string) =>
    ['conversation', accountId, threadId] as const,
  /** Prefix matching every conversation query for `accountId`, regardless of
   * `threadId` — `['conversation', accountId, '']` is NOT a prefix of
   * `['conversation', accountId, 'thread-1']` under TanStack's array-key
   * matching, so invalidations that mean "every open conversation for this
   * account" must use this instead. */
  conversationsForAccount: (accountId: string) => ['conversation', accountId] as const,
  syncStatus: (accountId: string) => ['syncStatus', accountId] as const,
  traversalStatus: (accountId: string) => ['traversalStatus', accountId] as const,
};
