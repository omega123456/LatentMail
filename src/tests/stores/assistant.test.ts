import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';
import { ipc } from '@/tests/ipc-mock';
import { isStreaming, QUESTION_LIMIT, useAssistantStore } from '@/stores/assistant';

function reset() {
  useAssistantStore.setState({
    sessionId: 'session-1',
    accountId: 'account-1',
    messages: [],
    activeRequestId: null,
    cancelPending: false,
    draft: '',
    historyCursor: null,
    displacedDraft: null,
  });
}

async function askAndSettle(question: string, requestId = 'request-1') {
  ipc.override('start_ai_chat', requestId);
  useAssistantStore.getState().ask(question);
  await waitFor(() => expect(useAssistantStore.getState().activeRequestId).toBe(requestId));
}

beforeEach(reset);

describe('assistant store', () => {
  it('appends the question and a streaming answer, then records the request id', async () => {
    await askAndSettle('  what is the deadline  ');
    const { messages } = useAssistantStore.getState();
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0].text).toBe('what is the deadline');
    expect(messages[1].streaming).toBe(true);
    expect(isStreaming(messages)).toBe(true);
    expect(useAssistantStore.getState().draft).toBe('');
  });

  it('refuses a blank question, an over-long question, and a second concurrent question', async () => {
    const start = vi.fn(() => 'request-1');
    ipc.override('start_ai_chat', start);
    useAssistantStore.getState().ask('   ');
    useAssistantStore.getState().ask('q'.repeat(QUESTION_LIMIT + 1));
    expect(start).not.toHaveBeenCalled();
    useAssistantStore.getState().ask('first');
    useAssistantStore.getState().ask('second');
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(useAssistantStore.getState().messages).toHaveLength(2);
  });

  it('reports a failed start as the answer error and ends the stream', async () => {
    ipc.override('start_ai_chat', () => {
      throw new Error('The index must be rebuilt');
    });
    useAssistantStore.getState().ask('what is the deadline');
    await waitFor(() =>
      expect(useAssistantStore.getState().messages[1].error).toContain('The index must be rebuilt'),
    );
    expect(isStreaming(useAssistantStore.getState().messages)).toBe(false);
  });

  it('streams deltas, keeps sources on completion, and drops them on cancellation', async () => {
    await askAndSettle('what is the deadline');
    const source = {
      number: 1,
      senderName: 'Priya Raman',
      senderAddress: 'priya@example.com',
      subject: 'Q3 budget',
      sentAtMillis: 1_700_000_100_000,
      messageId: 'message-1',
      threadId: 'thread-1',
    };
    useAssistantStore.getState().appendDelta('The deadline ');
    useAssistantStore.getState().appendDelta('is Friday [3].');
    useAssistantStore.getState().setSources([source], 'The deadline is Friday [1].');
    useAssistantStore.getState().finish({ cancelled: false, error: null });
    expect(useAssistantStore.getState().messages[1].text).toBe('The deadline is Friday [1].');
    expect(useAssistantStore.getState().messages[1].sources).toEqual([source]);

    await askAndSettle('and who owns it', 'request-2');
    useAssistantStore.getState().appendDelta('Priya');
    useAssistantStore.getState().setSources([source], 'Priya');
    useAssistantStore.getState().finish({ cancelled: true, error: null });
    const last = useAssistantStore.getState().messages.at(-1);
    expect(last?.text).toBe('Priya');
    expect(last?.sources).toEqual([]);
    expect(useAssistantStore.getState().activeRequestId).toBeNull();
  });

  it('cancels the running request through the command and stops streaming', async () => {
    await askAndSettle('what is the deadline');
    const cancel = vi.fn(() => true);
    ipc.override('cancel_ai_chat', cancel);
    useAssistantStore.getState().stop();
    expect(cancel).toHaveBeenCalledWith({ requestId: 'request-1' });
    expect(isStreaming(useAssistantStore.getState().messages)).toBe(false);
    useAssistantStore.getState().stop();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('cancels a request whose identity has not arrived yet as soon as it does', async () => {
    const cancel = vi.fn(() => true);
    ipc.override('cancel_ai_chat', cancel);
    ipc.override('start_ai_chat', 'request-late');
    useAssistantStore.getState().ask('what is the deadline');
    useAssistantStore.getState().stop();
    expect(useAssistantStore.getState().cancelPending).toBe(true);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ requestId: 'request-late' }));
    expect(useAssistantStore.getState().activeRequestId).toBeNull();
    expect(useAssistantStore.getState().cancelPending).toBe(false);
  });

  it('cancels a request identity that belongs to a session already replaced', async () => {
    const cancel = vi.fn(() => true);
    ipc.override('cancel_ai_chat', cancel);
    ipc.override('start_ai_chat', 'request-stale');
    useAssistantStore.getState().ask('what is the deadline');
    useAssistantStore.getState().newChat();
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ requestId: 'request-stale' }));
    expect(useAssistantStore.getState().messages).toHaveLength(0);
    expect(useAssistantStore.getState().activeRequestId).toBeNull();
  });

  it('reports a start failure for a replaced session against nothing', async () => {
    ipc.override('start_ai_chat', () => {
      throw new Error('gone');
    });
    useAssistantStore.getState().ask('what is the deadline');
    const sessionId = useAssistantStore.getState().sessionId;
    useAssistantStore.getState().newChat();
    await waitFor(() => expect(useAssistantStore.getState().sessionId).not.toBe(sessionId));
    expect(useAssistantStore.getState().messages).toHaveLength(0);
  });

  it('starts a new session for a new account and keeps one for the same account', async () => {
    await askAndSettle('what is the deadline');
    const sessionId = useAssistantStore.getState().sessionId;
    useAssistantStore.getState().selectAccount('account-1');
    expect(useAssistantStore.getState().sessionId).toBe(sessionId);
    expect(useAssistantStore.getState().messages).toHaveLength(2);

    ipc.override('cancel_ai_chat', true);
    useAssistantStore.getState().selectAccount('account-2');
    expect(useAssistantStore.getState().accountId).toBe('account-2');
    expect(useAssistantStore.getState().messages).toHaveLength(0);
    expect(useAssistantStore.getState().sessionId).not.toBe(sessionId);
  });

  it('walks prompt history and restores the draft displaced by browsing', async () => {
    await askAndSettle('first question');
    useAssistantStore.getState().finish({ cancelled: false, error: null });
    await askAndSettle('second question', 'request-2');
    useAssistantStore.getState().finish({ cancelled: false, error: null });
    useAssistantStore.getState().setDraft('unsent draft');

    useAssistantStore.getState().historyPrevious();
    expect(useAssistantStore.getState().draft).toBe('second question');
    useAssistantStore.getState().historyPrevious();
    expect(useAssistantStore.getState().draft).toBe('first question');
    useAssistantStore.getState().historyPrevious();
    expect(useAssistantStore.getState().draft).toBe('first question');
    useAssistantStore.getState().historyNext();
    expect(useAssistantStore.getState().draft).toBe('second question');
    useAssistantStore.getState().historyNext();
    expect(useAssistantStore.getState().draft).toBe('unsent draft');
    expect(useAssistantStore.getState().historyCursor).toBeNull();
  });

  it('leaves the draft alone when there is no history to walk', () => {
    useAssistantStore.getState().setDraft('only a draft');
    useAssistantStore.getState().historyPrevious();
    useAssistantStore.getState().historyNext();
    expect(useAssistantStore.getState().draft).toBe('only a draft');
  });

  it('refuses to ask before an account is chosen', () => {
    const start = vi.fn(() => 'request-1');
    ipc.override('start_ai_chat', start);
    useAssistantStore.setState({ accountId: null });
    useAssistantStore.getState().ask('what is the deadline');
    expect(start).not.toHaveBeenCalled();
  });

  it('ignores deltas and sources when no assistant message exists', () => {
    useAssistantStore.getState().appendDelta('orphan');
    useAssistantStore.getState().setSources([], 'orphan');
    useAssistantStore.getState().finish({ cancelled: false, error: null });
    expect(useAssistantStore.getState().messages).toHaveLength(0);
  });
});
