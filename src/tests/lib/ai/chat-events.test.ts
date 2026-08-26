import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ipc } from '@/tests/ipc-mock';
import { AssistantChatEvents, handleAssistantChatEvent } from '@/lib/ai/chat-events';
import { EventBridge } from '@/lib/query/event-bridge';
import { useAssistantStore, type AssistantMessage } from '@/stores/assistant';
import type { AiChatEvent } from '@/lib/types/ipc';

const source = {
  number: 1,
  senderName: 'Priya Raman',
  senderAddress: 'priya@example.com',
  subject: 'Q3 budget',
  sentAtMillis: 1_700_000_100_000,
  messageId: 'message-1',
  threadId: 'thread-1',
};

function streamingMessages(): AssistantMessage[] {
  return [
    {
      id: 'user-1',
      role: 'user',
      text: 'what is the deadline',
      error: null,
      sources: [],
      streaming: false,
      createdAt: 0,
    },
    {
      id: 'assistant-1',
      role: 'assistant',
      text: '',
      error: null,
      sources: [],
      streaming: true,
      createdAt: 0,
    },
  ];
}

function identity(overrides: Partial<AiChatEvent> = {}) {
  return {
    requestId: 'request-1',
    sessionId: 'session-1',
    accountId: 'account-1',
    ...overrides,
  };
}

beforeEach(() => {
  useAssistantStore.setState({
    sessionId: 'session-1',
    accountId: 'account-1',
    messages: streamingMessages(),
    activeRequestId: 'request-1',
    cancelPending: false,
    draft: '',
    historyCursor: null,
    displacedDraft: null,
  });
});

describe('assistant chat events', () => {
  it('writes deltas, sources and the terminal state into the session', () => {
    handleAssistantChatEvent({ ...identity(), kind: 'started' });
    handleAssistantChatEvent({ ...identity(), kind: 'delta', text: 'The deadline ' });
    handleAssistantChatEvent({ ...identity(), kind: 'delta', text: 'is Friday [4].' });
    handleAssistantChatEvent({
      ...identity(),
      kind: 'sources',
      sources: [source],
      answer: 'The deadline is Friday [1].',
    });
    handleAssistantChatEvent({ ...identity(), kind: 'done', cancelled: false, error: null });
    const message = useAssistantStore.getState().messages[1];
    expect(message.text).toBe('The deadline is Friday [1].');
    expect(message.sources).toEqual([source]);
    expect(message.streaming).toBe(false);
    expect(useAssistantStore.getState().activeRequestId).toBeNull();
  });

  it('adopts the request identity from the first event when the command has not returned yet', () => {
    useAssistantStore.setState({ activeRequestId: null });
    handleAssistantChatEvent({ ...identity(), kind: 'started' });
    expect(useAssistantStore.getState().activeRequestId).toBe('request-1');
  });

  it('rejects an event from a stale request', () => {
    handleAssistantChatEvent({
      ...identity({ requestId: 'request-old' }),
      kind: 'delta',
      text: 'stale',
    });
    expect(useAssistantStore.getState().messages[1].text).toBe('');
  });

  it('rejects an event from another session', () => {
    handleAssistantChatEvent({
      ...identity({ sessionId: 'session-old' }),
      kind: 'delta',
      text: 'stale',
    });
    expect(useAssistantStore.getState().messages[1].text).toBe('');
  });

  it('rejects an event from another account', () => {
    handleAssistantChatEvent({
      ...identity({ accountId: 'account-2' }),
      kind: 'delta',
      text: 'stale',
    });
    expect(useAssistantStore.getState().messages[1].text).toBe('');
  });

  it('rejects a completion that arrives after the request was cancelled', () => {
    useAssistantStore.getState().finish({ cancelled: true, error: null });
    handleAssistantChatEvent({ ...identity(), kind: 'delta', text: 'late text' });
    handleAssistantChatEvent({
      ...identity(),
      kind: 'sources',
      sources: [source],
      answer: 'late text [1]',
    });
    handleAssistantChatEvent({
      ...identity(),
      kind: 'done',
      cancelled: false,
      error: 'late failure',
    });
    const message = useAssistantStore.getState().messages[1];
    expect(message.text).toBe('');
    expect(message.sources).toEqual([]);
    expect(message.error).toBeNull();
  });

  it('subscribes while mounted and stops on unmount', async () => {
    const { unmount } = render(createElement(AssistantChatEvents));
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('ai-chat://event', expect.any(Function)),
    );
    act(() => {
      ipc.emit('ai-chat://event', { ...identity(), kind: 'delta', text: 'through the listener' });
    });
    expect(useAssistantStore.getState().messages[1].text).toBe('through the listener');
    unmount();
    act(() => {
      ipc.emit('ai-chat://event', { ...identity(), kind: 'delta', text: ' more' });
    });
    expect(useAssistantStore.getState().messages[1].text).toBe('through the listener');
  });

  it('keeps chat content out of the application log because the bridge never subscribes to it', async () => {
    const client = new QueryClient();
    render(createElement(QueryClientProvider, { client }, createElement(EventBridge)));
    await waitFor(() => expect(ipc.tauriListen).toHaveBeenCalled());
    act(() => {
      ipc.emit('ai-chat://event', {
        ...identity(),
        kind: 'delta',
        text: 'secret answer text',
      });
    });
    const logged = ipc.tauriInvoke.mock.calls.filter(
      ([command]) => command === 'write_frontend_log',
    );
    expect(logged.some(([, args]) => JSON.stringify(args).includes('secret answer text'))).toBe(
      false,
    );
    expect(ipc.tauriListen.mock.calls.some(([event]) => event === 'ai-chat://event')).toBe(false);
    client.clear();
  });
});
