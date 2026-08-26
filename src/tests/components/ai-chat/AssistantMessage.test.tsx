import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AssistantMessage } from '@/components/ai-chat/AssistantMessage';
import type { AssistantMessage as AssistantMessageModel } from '@/stores/assistant';

const message = (overrides: Partial<AssistantMessageModel> = {}): AssistantMessageModel => ({
  id: 'assistant-1',
  role: 'assistant',
  text: 'The deadline is **Friday** [1].',
  error: null,
  sources: [],
  streaming: false,
  createdAt: 0,
  ...overrides,
});

describe('AssistantMessage', () => {
  it('renders a question as plain text in its own bubble', () => {
    render(
      <AssistantMessage
        message={message({ role: 'user', text: 'What is **not** markdown here?' })}
        onSourceActivate={vi.fn()}
      />,
    );
    expect(screen.getByText('What is **not** markdown here?')).toBeInTheDocument();
    expect(screen.getByText('You')).toBeInTheDocument();
  });

  it('renders an answer through the Markdown renderer with its sources', () => {
    render(
      <AssistantMessage
        message={message({
          sources: [
            {
              number: 1,
              senderName: 'Priya Raman',
              senderAddress: 'priya@example.com',
              subject: 'Q3 budget',
              sentAtMillis: 1_700_000_100_000,
              messageId: 'message-1',
              threadId: 'thread-1',
            },
          ],
        })}
        onSourceActivate={vi.fn()}
      />,
    );
    expect(screen.getByText('Friday').tagName).toBe('STRONG');
    expect(screen.getByText('Sources')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Priya Raman/ })).toBeInTheDocument();
  });

  it('marks a streaming answer busy and shows its caret until the stream ends', () => {
    const { rerender } = render(
      <AssistantMessage message={message({ streaming: true })} onSourceActivate={vi.fn()} />,
    );
    expect(screen.getByTestId('assistant-message-assistant')).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('assistant-caret')).toBeInTheDocument();
    rerender(<AssistantMessage message={message()} onSourceActivate={vi.fn()} />);
    expect(screen.getByTestId('assistant-message-assistant')).not.toHaveAttribute('aria-busy');
    expect(screen.queryByTestId('assistant-caret')).toBeNull();
  });

  it('shows failure text in the error treatment and copies it', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    render(
      <AssistantMessage
        message={message({ text: '', error: 'Provider returned a server error' })}
        onSourceActivate={vi.fn()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Provider returned a server error');
    await user.click(screen.getByRole('button', { name: 'Copy message' }));
    expect(writeText).toHaveBeenCalledWith('Provider returned a server error');
    expect(await screen.findByText('Copied message')).toBeInTheDocument();
  });

  it('offers no copy control for a message with nothing in it yet', () => {
    render(
      <AssistantMessage
        message={message({ text: '', streaming: true })}
        onSourceActivate={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Copy message' })).toBeNull();
  });
});
