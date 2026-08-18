import { describe, expect, it } from 'vitest';
import { queryKeys } from '@/lib/query/keys';

describe('queryKeys', () => {
  it('builds stable, account-scoped keys for every domain', () => {
    expect(queryKeys.accounts).toEqual(['accounts']);
    expect(queryKeys.labels('account-1')).toEqual(['labels', 'account-1']);
    expect(queryKeys.threads('account-1', 'INBOX')).toEqual(['threads', 'account-1', 'INBOX']);
    expect(queryKeys.threadsForAccount('account-1')).toEqual(['threads', 'account-1']);
    expect(queryKeys.conversationThread('account-1', 'thread-1')).toEqual([
      'conversation',
      'account-1',
      'thread-1',
    ]);
    expect(queryKeys.conversation('account-1', 'thread-1', 'policy')).toEqual([
      'conversation',
      'account-1',
      'thread-1',
      'policy',
    ]);
    expect(queryKeys.syncStatus('account-1')).toEqual(['syncStatus', 'account-1']);
    expect(queryKeys.traversalStatus('account-1')).toEqual(['traversalStatus', 'account-1']);
    expect(queryKeys.queueOperations).toEqual(['queueOperations']);
  });

  it('scopes traversalStatus per account, matching the array-prefix invalidation convention', () => {
    expect(queryKeys.traversalStatus('account-1')).not.toEqual(
      queryKeys.traversalStatus('account-2'),
    );
  });
});
