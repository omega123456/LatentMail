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
  syncStatus: (accountId: string) => ['syncStatus', accountId] as const,
};
