import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ReadingPane, readerFixtures } from '@/components/reader/ReadingPane';

describe('ReadingPane', () => {
  it('renders reader states', () => {
    const { rerender } = render(<ReadingPane threadId={null} />);
    expect(screen.getByText('Select a conversation to read it.')).toBeInTheDocument();
    rerender(<ReadingPane threadId="thread-1" loading />);
    expect(screen.getByText('Loading conversation…')).toBeInTheDocument();
    rerender(<ReadingPane threadId="thread-1" error />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this conversation.');
  });

  it('keeps the newest message expanded and toggles older messages', async () => {
    const user = userEvent.setup();
    render(<ReadingPane threadId="thread-1" />);
    expect(screen.getByTestId('message-message-1')).toHaveTextContent(
      "I've attached the finalized slides for tomorrow's presentation.",
    );
    expect(screen.getByLabelText('Message body')).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('Q3 Marketing Strategy presentation'),
    );
    await user.click(screen.getByRole('button', { name: 'Expand message from Elena Rodriguez' }));
    expect(screen.getAllByLabelText('Message body')).toHaveLength(2);
    expect(screen.getByText('Remote images are blocked.')).toBeInTheDocument();
  });

  it('sanitizes HTML before it reaches the sandboxed iframe', () => {
    const conversation = structuredClone(readerFixtures['thread-1']);
    conversation.messages[1].html =
      '<p>Safe</p><script>window.bad = true</script><img src=x onerror="window.bad = true">';
    render(<ReadingPane threadId="thread-1" conversation={conversation} />);
    const frame = screen.getByLabelText('Message body');
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(frame.getAttribute('srcdoc')).not.toContain('script');
    expect(frame.getAttribute('srcdoc')).not.toContain('onerror');
  });

  it('preserves plain text and renders an empty body state', () => {
    const conversation = structuredClone(readerFixtures['thread-1']);
    conversation.messages[1].html = null;
    conversation.messages[1].text = 'first line\n  second line';
    const { rerender } = render(<ReadingPane threadId="thread-1" conversation={conversation} />);
    expect(
      screen.getByText((_, element) => element?.textContent === 'first line\n  second line'),
    ).toHaveClass('whitespace-pre-wrap');
    conversation.messages[1].text = null;
    rerender(<ReadingPane threadId="thread-1" conversation={conversation} />);
    expect(screen.getByText('This message has no content.')).toBeInTheDocument();
  });
});
