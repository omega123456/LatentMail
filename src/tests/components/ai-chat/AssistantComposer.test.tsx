import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssistantComposer } from '@/components/ai-chat/AssistantComposer';
import { ipc } from '@/tests/ipc-mock';
import { QUESTION_LIMIT, useAssistantStore, type AssistantMessage } from '@/stores/assistant';

const message = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: 'assistant-1',
  role: 'assistant',
  text: '',
  error: null,
  sources: [],
  streaming: false,
  createdAt: 0,
  ...overrides,
});

function reset(overrides: Partial<ReturnType<typeof useAssistantStore.getState>> = {}) {
  act(() => {
    useAssistantStore.setState({
      sessionId: 'session-1',
      accountId: 'account-1',
      messages: [],
      activeRequestId: null,
      cancelPending: false,
      draft: '',
      historyCursor: null,
      displacedDraft: null,
      ...overrides,
    });
  });
}

beforeEach(() => reset());

describe('AssistantComposer', () => {
  it('sends on Enter and inserts a newline on Shift+Enter', async () => {
    const user = userEvent.setup();
    const start = vi.fn(() => 'request-1');
    ipc.override('start_ai_chat', start);
    render(<AssistantComposer />);
    const prompt = screen.getByLabelText('Ask a question');
    await user.type(prompt, 'first line');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(prompt, 'second line');
    expect(useAssistantStore.getState().draft).toBe('first line\nsecond line');
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        accountId: 'account-1',
        sessionId: 'session-1',
        question: 'first line\nsecond line',
      }),
    );
  });

  it('turns the prompt on for spellcheck while the shared control stays neutral', () => {
    render(<AssistantComposer />);
    expect(screen.getByLabelText('Ask a question')).toHaveAttribute('spellcheck', 'true');
  });

  it('keeps Send inert for a blank draft and marks an over-long one', async () => {
    render(<AssistantComposer />);
    expect(screen.getByRole('button', { name: 'Send question' })).toBeDisabled();
    reset({ draft: '   ' });
    expect(screen.getByRole('button', { name: 'Send question' })).toBeDisabled();
    reset({ draft: 'x'.repeat(QUESTION_LIMIT + 114) });
    expect(screen.getByRole('button', { name: 'Send question' })).toBeDisabled();
    expect(screen.getByTestId('assistant-counter')).toHaveTextContent(`2114 / ${QUESTION_LIMIT}`);
    expect(screen.getByTestId('assistant-counter')).toHaveClass('text-error');
  });

  it('sends the draft when Send is activated', async () => {
    const user = userEvent.setup();
    const start = vi.fn(() => 'request-1');
    ipc.override('start_ai_chat', start);
    reset({ draft: 'which invoices are unpaid?' });
    render(<AssistantComposer />);
    await user.click(screen.getByRole('button', { name: 'Send question' }));
    await waitFor(() => expect(start).toHaveBeenCalled());
  });

  it('swaps Send for Stop while a response is active and disables the prompt', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(() => true);
    ipc.override('cancel_ai_chat', cancel);
    reset({
      messages: [message({ streaming: true })],
      activeRequestId: 'request-1',
    });
    render(<AssistantComposer />);
    expect(screen.getByLabelText('Ask a question')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Send question' })).toBeNull();
    expect(screen.getByText('Answering…')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop answering' }));
    expect(cancel).toHaveBeenCalledWith({ requestId: 'request-1' });
    expect(screen.getByRole('button', { name: 'Send question' })).toBeInTheDocument();
  });

  it('walks prompt history with Up and Down and restores the displaced draft', async () => {
    const user = userEvent.setup();
    reset({
      messages: [
        message({ id: 'user-1', role: 'user', text: 'first question' }),
        message({ id: 'assistant-1', text: 'first answer' }),
        message({ id: 'user-2', role: 'user', text: 'second question' }),
        message({ id: 'assistant-2', text: 'second answer' }),
      ],
      draft: 'unsent draft',
    });
    render(<AssistantComposer />);
    const prompt = screen.getByLabelText('Ask a question');
    prompt.focus();
    await user.keyboard('{ArrowUp}');
    expect(prompt).toHaveValue('second question');
    await user.keyboard('{ArrowUp}');
    expect(prompt).toHaveValue('first question');
    await user.keyboard('{ArrowDown}');
    expect(prompt).toHaveValue('second question');
    await user.keyboard('{ArrowDown}');
    expect(prompt).toHaveValue('unsent draft');
  });
});
