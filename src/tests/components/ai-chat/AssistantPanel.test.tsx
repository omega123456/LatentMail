import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantPanel, unavailableCause } from '@/components/ai-chat/AssistantPanel';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { ipc } from '@/tests/ipc-mock';
import { getTime, parseISO } from 'date-fns';
import { useAssistantStore } from '@/stores/assistant';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import type { AiConfig, AiIndexStatus } from '@/lib/types/ipc';

const config = (overrides: Partial<AiConfig> = {}): AiConfig => ({
  accountId: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex',
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  chatModel: 'chat',
  embeddingModel: 'embedding',
  embeddingDimensions: 768,
  hasApiKey: true,
  indexPaused: false,
  ...overrides,
});

const status = (overrides: Partial<AiIndexStatus> = {}): AiIndexStatus => ({
  accountId: 'account-1',
  state: 'complete',
  indexed: 8600,
  total: 8600,
  indexedMessages: 8600,
  totalEligibleMessages: 8600,
  indexedPassages: 12000,
  paused: false,
  error: null,
  ...overrides,
});

function ready(overrides: { config?: Partial<AiConfig>; status?: Partial<AiIndexStatus> } = {}) {
  ipc.override('read_ai_configs', [config(overrides.config)]);
  ipc.override('read_ai_index_status', [status(overrides.status)]);
  ipc.override('test_ai_connection', 4);
}

function renderPanel(onClose = vi.fn(), onOpenAiSettings = vi.fn()) {
  return {
    onClose,
    onOpenAiSettings,
    ...renderWithQueryClient(
      <AssistantPanel
        accountId="account-1"
        onClose={onClose}
        onOpenAiSettings={onOpenAiSettings}
      />,
    ),
  };
}

beforeEach(() => {
  act(() => {
    useAssistantStore.setState({
      sessionId: 'session-1',
      accountId: null,
      messages: [],
      activeRequestId: null,
      cancelPending: false,
      draft: '',
      historyCursor: null,
      displacedDraft: null,
    });
  });
});

describe('AssistantPanel', () => {
  it('maps every readiness gap onto its own cause', () => {
    expect(unavailableCause(undefined, undefined, true)).toBe('disabled');
    expect(unavailableCause(config({ enabled: false }), status(), true)).toBe('disabled');
    expect(unavailableCause(config({ baseUrl: null }), status(), true)).toBe('noApiRoot');
    expect(unavailableCause(config({ chatModel: null }), status(), true)).toBe('noChatModel');
    expect(unavailableCause(config(), status({ state: 'needsRebuild' }), true)).toBe(
      'needsRebuild',
    );
    expect(unavailableCause(config(), status({ state: 'building' }), true)).toBe('indexNotReady');
    expect(unavailableCause(config(), status({ state: 'partial' }), false)).toBe('unreachable');
    expect(unavailableCause(config(), status(), true)).toBeNull();
  });

  it('opens ready, focuses the prompt, and offers the example questions', async () => {
    ready();
    renderPanel();
    expect(await screen.findByRole('button', { name: 'New chat' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByLabelText('Ask a question')).toHaveFocus());
    expect(screen.getByText('Ask about your inbox')).toBeInTheDocument();
    expect(useAssistantStore.getState().accountId).toBe('account-1');
  });

  it('asks the example question that was activated', async () => {
    const user = userEvent.setup();
    ready();
    const start = vi.fn(() => 'request-1');
    ipc.override('start_ai_chat', start);
    renderPanel();
    await user.click(
      await screen.findByRole('button', { name: 'Find emails about budget or finance' }),
    );
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        accountId: 'account-1',
        sessionId: useAssistantStore.getState().sessionId,
        question: 'Find emails about budget or finance',
      }),
    );
    expect(screen.getByRole('log')).toHaveTextContent('Find emails about budget or finance');
  });

  it('hides New chat and the composer while the account is unavailable', async () => {
    ready({ config: { enabled: false } });
    const { onOpenAiSettings } = renderPanel();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Open AI settings' }));
    expect(onOpenAiSettings).toHaveBeenCalledWith('disabled');
    expect(screen.queryByRole('button', { name: 'New chat' })).toBeNull();
    expect(screen.queryByLabelText('Ask a question')).toBeNull();
  });

  it('reports an unreachable provider from the polled connection query', async () => {
    ipc.override('read_ai_configs', [config()]);
    ipc.override('read_ai_index_status', [status()]);
    ipc.override('test_ai_connection', () => {
      throw new Error('Could not connect to provider');
    });
    renderPanel();
    expect(await screen.findByText('Cannot reach the provider')).toBeInTheDocument();
  });

  it('closes from the header control and from Escape without letting Escape escape', async () => {
    const user = userEvent.setup();
    ready();
    const { onClose } = renderPanel();
    const windowEscape = vi.fn();
    window.addEventListener('keydown', windowEscape);
    await user.click(await screen.findByRole('button', { name: 'Close panel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    screen.getByLabelText('Ask a question').focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(windowEscape).not.toHaveBeenCalled();
    window.removeEventListener('keydown', windowEscape);
  });

  it('opens a cited email in the reading pane and touches nothing else', async () => {
    const user = userEvent.setup();
    ready();
    useSearchStore.setState({ submittedQuery: 'invoice', active: true });
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: null,
    });
    renderPanel();
    await screen.findByRole('button', { name: 'New chat' });
    act(() =>
      useAssistantStore.setState({
        messages: [
          {
            id: 'assistant-1',
            role: 'assistant',
            text: 'One is outstanding [1].',
            error: null,
            sources: [
              {
                number: 1,
                senderName: 'AutoCare Garage',
                senderAddress: 'billing@autocare.example',
                subject: 'Invoice #40218',
                sentAtMillis: getTime(parseISO('2026-08-11T09:12:00Z')),
                messageId: 'message-9',
                threadId: 'thread-9',
              },
            ],
            streaming: false,
            createdAt: 0,
          },
        ],
      }),
    );

    await user.click(await screen.findByRole('button', { name: /AutoCare Garage/ }));

    expect(useSelectionStore.getState()).toMatchObject({
      activeThreadId: 'thread-9',
      activeMailboxId: 'INBOX',
      activeAccountId: 'account-1',
    });
    expect(useSearchStore.getState().submittedQuery).toBe('invoice');
  });

  it('clears the transcript on New chat', async () => {
    const user = userEvent.setup();
    ready();
    ipc.override('start_ai_chat', 'request-1');
    renderPanel();
    await user.click(await screen.findByRole('button', { name: 'Who emailed me most recently?' }));
    await waitFor(() => expect(useAssistantStore.getState().messages).toHaveLength(2));
    ipc.override('cancel_ai_chat', true);
    await user.click(screen.getByRole('button', { name: 'New chat' }));
    expect(useAssistantStore.getState().messages).toHaveLength(0);
    expect(screen.getByText('Ask about your inbox')).toBeInTheDocument();
  });
});
