import { beforeEach, describe, expect, it } from 'vitest';
import { useMultiSelectStore } from '@/stores/multi-select';
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
