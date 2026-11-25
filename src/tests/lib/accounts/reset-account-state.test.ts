import { beforeEach, describe, expect, it } from 'vitest';
import { clearStateForRemovedAccount } from '@/lib/accounts/reset-account-state';
import { useAssistantStore } from '@/stores/assistant';
import { useComposeStore } from '@/stores/compose';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';

const QUESTION_AND_ANSWER = 2;

beforeEach(() => {
  useSelectionStore.getState().clearAccount();
  useMultiSelectStore.setState({ selectedIds: new Set(['a', 'b']), anchorId: 'b' });
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
      flashThreadId: 'thread-1',
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

    clearStateForRemovedAccount('account-1');

    expect(useSelectionStore.getState()).toMatchObject({
      activeAccountId: null,
      activeMailboxId: null,
      activeThreadId: null,
      keyboardCursor: null,
      flashThreadId: null,
    });
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
    expect(useSearchStore.getState().active).toBe(false);
    expect(useSearchStore.getState().submittedQuery).toBe('');
    expect(useComposeStore.getState().session).toBeNull();
  });

  it('keeps the active account but clears the thread when a different account is removed', () => {
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: 'thread-1',
      keyboardCursor: 3,
    });

    clearStateForRemovedAccount('account-2');

    expect(useSelectionStore.getState().activeAccountId).toBe('account-1');
    expect(useSelectionStore.getState().activeThreadId).toBeNull();
  });
});

describe('clearStateForRemovedAccount — the assistant session', () => {
  beforeEach(() => {
    useAssistantStore.setState({
      sessionId: 'session-1',
      accountId: 'account-1',
      messages: [
        {
          id: 'user-1',
          role: 'user',
          text: 'Which invoices are unpaid?',
          error: null,
          sources: [],
          streaming: false,
          createdAt: 0,
        },
        {
          id: 'assistant-1',
          role: 'assistant',
          text: 'One is',
          error: null,
          sources: [],
          streaming: true,
          createdAt: 0,
        },
      ],
      activeRequestId: 'request-1',
      cancelPending: false,
      draft: 'half typed',
      historyCursor: null,
      displacedDraft: null,
    });
  });

  it('cancels and clears when the active account is removed', () => {
    const cancelled: unknown[] = [];
    ipc.override('cancel_ai_chat', (request) => {
      cancelled.push(request);
      return true;
    });
    useSelectionStore.setState({ activeAccountId: 'account-1' });

    clearStateForRemovedAccount('account-1');

    expect(cancelled).toEqual([{ requestId: 'request-1' }]);
    expect(useAssistantStore.getState()).toMatchObject({
      accountId: null,
      messages: [],
      activeRequestId: null,
    });
  });

  it('leaves the session alone when another account is removed', () => {
    useSelectionStore.setState({ activeAccountId: 'account-1' });
    clearStateForRemovedAccount('account-2');
    expect(useAssistantStore.getState().messages).toHaveLength(QUESTION_AND_ANSWER);
  });
});
