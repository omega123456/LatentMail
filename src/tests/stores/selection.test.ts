import { beforeEach, describe, expect, it } from 'vitest';
import { useComposeStore } from '@/stores/compose';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';

beforeEach(() => {
  useSelectionStore.setState({
    activeAccountId: null,
    activeMailboxId: null,
    activeThreadId: null,
    keyboardCursor: null,
  });
  useMultiSelectStore.setState({ selectedIds: new Set(['a', 'b']), anchorId: 'b' });
});

describe('selection store coordination with multi-select', () => {
  it('clears the multi-selection when a thread is opened (plain click/keyboard open)', () => {
    useSelectionStore.getState().setActiveThreadId('thread-1');
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
  });

  it('does not touch the multi-selection when the open thread is cleared to null', () => {
    useSelectionStore.getState().setActiveThreadId(null);
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(2);
  });

  it('clears the multi-selection when the mailbox changes', () => {
    useSelectionStore.getState().setActiveMailboxId('SENT');
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
  });

  it('clears the multi-selection when the account changes', () => {
    useSelectionStore.getState().setActiveAccountId('account-2');
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
  });
});

describe('clearStateForRemovedAccount', () => {
  beforeEach(() => {
    useSearchStore.setState({
      draft: 'hello',
      submittedQuery: 'hello',
      scope: { kind: 'default' },
      active: true,
      panelOpen: true,
    });
    useComposeStore.setState({ session: null });
  });

  it('clears selection, multi-select, search and compose state for the removed active account', () => {
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: 'thread-1',
      keyboardCursor: 3,
    });
    useComposeStore.getState().open({
      id: 'session-1',
      mode: 'new',
      accountId: 'account-1',
      from: 'alex@example.com',
      recipients: { to: [], cc: [], bcc: [] },
      subject: '',
      html: '',
    });

    useSelectionStore.getState().clearStateForRemovedAccount('account-1');

    expect(useSelectionStore.getState()).toMatchObject({
      activeAccountId: null,
      activeMailboxId: null,
      activeThreadId: null,
      keyboardCursor: null,
    });
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
    expect(useSearchStore.getState().active).toBe(false);
    expect(useSearchStore.getState().submittedQuery).toBe('');
    expect(useComposeStore.getState().session).toBeNull();
  });

  it('does not clear the active account when a different account is removed', () => {
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: 'thread-1',
      keyboardCursor: 3,
    });

    useSelectionStore.getState().clearStateForRemovedAccount('account-2');

    expect(useSelectionStore.getState().activeAccountId).toBe('account-1');
    expect(useSelectionStore.getState().activeThreadId).toBe('thread-1');
  });
});
