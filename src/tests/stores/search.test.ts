import { beforeEach, describe, expect, it } from 'vitest';
import { useSearchStore } from '@/stores/search';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';

beforeEach(() => {
  useSearchStore.setState({
    draft: '',
    submittedQuery: '',
    scope: { kind: 'default' },
    active: false,
    panelOpen: false,
  });
  useSelectionStore.setState({
    activeAccountId: 'account-1',
    activeMailboxId: 'INBOX',
    activeThreadId: 'thread-1',
    keyboardCursor: 3,
  });
  useMultiSelectStore.setState({ selectedIds: new Set(['thread-1']), anchorId: 'thread-1' });
});

describe('search store', () => {
  it('submitting activates search, sets the submitted query, and closes the panel', () => {
    useSearchStore.getState().openPanel();
    useSearchStore.getState().submit('from:anna');
    const state = useSearchStore.getState();
    expect(state.active).toBe(true);
    expect(state.submittedQuery).toBe('from:anna');
    expect(state.draft).toBe('from:anna');
    expect(state.panelOpen).toBe(false);
  });

  it('submitting clears thread selection and multi-selection without touching activeMailboxId', () => {
    useSearchStore.getState().submit('from:anna');
    expect(useSelectionStore.getState().activeThreadId).toBeNull();
    expect(useSelectionStore.getState().keyboardCursor).toBeNull();
    expect(useSelectionStore.getState().activeMailboxId).toBe('INBOX');
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
  });

  it('clear resets every field back to idle', () => {
    useSearchStore.getState().submit('from:anna');
    useSearchStore.getState().clear();
    const state = useSearchStore.getState();
    expect(state).toMatchObject({
      draft: '',
      submittedQuery: '',
      active: false,
      panelOpen: false,
    });
  });

  it('setScope and setDraft update independently of submission', () => {
    useSearchStore.getState().setDraft('has:attachment');
    useSearchStore.getState().setScope({ kind: 'all' });
    const state = useSearchStore.getState();
    expect(state.draft).toBe('has:attachment');
    expect(state.scope).toEqual({ kind: 'all' });
    expect(state.active).toBe(false);
  });

  it('openPanel and closePanel toggle the panel flag', () => {
    useSearchStore.getState().openPanel();
    expect(useSearchStore.getState().panelOpen).toBe(true);
    useSearchStore.getState().closePanel();
    expect(useSearchStore.getState().panelOpen).toBe(false);
  });
});
