import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssistantTranscript } from '@/components/ai-chat/AssistantTranscript';
import type { AssistantMessage } from '@/stores/assistant';

const message = (overrides: Partial<AssistantMessage> = {}): AssistantMessage => ({
  id: 'assistant-1',
  role: 'assistant',
  text: 'answer',
  error: null,
  sources: [],
  streaming: false,
  createdAt: 0,
  ...overrides,
});

describe('AssistantTranscript', () => {
  it('exposes a polite log region that is not atomic', () => {
    render(<AssistantTranscript messages={[]} onSourceActivate={vi.fn()} />);
    const log = screen.getByRole('log');
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(log).toHaveAttribute('aria-atomic', 'false');
  });

  it('renders messages in order and marks only the streaming one busy', () => {
    render(
      <AssistantTranscript
        messages={[
          message({ id: 'user-1', role: 'user', text: 'question' }),
          message({ streaming: true, text: 'partial' }),
        ]}
        onSourceActivate={vi.fn()}
      />,
    );
    const rendered = screen.getByRole('log').children;
    expect(rendered[0]).toHaveTextContent('question');
    expect(rendered[0]).not.toHaveAttribute('aria-busy');
    expect(rendered[1]).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByTestId('assistant-caret')).not.toHaveAttribute('aria-live');
  });

  it('follows the stream to the newest content as it grows', () => {
    const { rerender } = render(
      <AssistantTranscript messages={[message({ text: 'a' })]} onSourceActivate={vi.fn()} />,
    );
    const log = screen.getByRole('log');
    Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 420 });
    rerender(
      <AssistantTranscript
        messages={[message({ text: 'a longer answer' })]}
        onSourceActivate={vi.fn()}
      />,
    );
    expect(log.scrollTop).toBe(420);
  });
});
