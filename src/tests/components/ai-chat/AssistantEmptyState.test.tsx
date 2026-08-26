import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ASSISTANT_EXAMPLES, AssistantEmptyState } from '@/components/ai-chat/AssistantEmptyState';

describe('AssistantEmptyState', () => {
  it('offers a heading and three example questions', () => {
    render(<AssistantEmptyState onSelect={vi.fn()} />);
    expect(screen.getByText('Ask about your inbox')).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(ASSISTANT_EXAMPLES.length);
    expect(ASSISTANT_EXAMPLES).toHaveLength(3);
  });

  it('submits the example that was activated', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<AssistantEmptyState onSelect={onSelect} />);
    await user.click(screen.getByRole('button', { name: ASSISTANT_EXAMPLES[1] }));
    expect(onSelect).toHaveBeenCalledWith(ASSISTANT_EXAMPLES[1]);
  });
});
