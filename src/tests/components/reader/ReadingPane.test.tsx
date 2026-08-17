import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReadingPane, readerFixtures } from '@/components/reader/ReadingPane';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

describe('ReadingPane', () => {
  it('renders reader states', () => {
    const { rerender } = renderWithQueryClient(<ReadingPane threadId={null} />);
    expect(screen.getByText('Select a conversation to read it.')).toBeInTheDocument();
    rerender(<ReadingPane threadId="thread-1" loading />);
    expect(screen.getByText('Loading conversation…')).toBeInTheDocument();
    rerender(<ReadingPane threadId="thread-1" error />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load this conversation.');
  });

  it('keeps the newest message expanded and toggles older messages', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ReadingPane threadId="thread-1" />);
    expect(screen.getByTestId('message-message-1')).toHaveTextContent(
      "I've attached the finalized slides for tomorrow's presentation.",
    );
    expect(screen.getByLabelText('Message body')).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('Q3 Marketing Strategy presentation'),
    );
    expect(screen.getByLabelText('Message body')).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('body{max-width:42rem;margin:0 auto'),
    );
    await user.click(screen.getByRole('button', { name: 'Expand message from Elena Rodriguez' }));
    expect(screen.getAllByLabelText('Message body')).toHaveLength(2);
    expect(screen.getByText('Remote images are blocked.')).toBeInTheDocument();
  });

  it('sanitizes HTML before it reaches the sandboxed iframe', async () => {
    const conversation = structuredClone(readerFixtures['thread-1']);
    conversation.messages[1].html =
      '<p>Safe</p><script>window.bad = true</script><img src=x onerror="window.bad = true">';
    renderWithQueryClient(<ReadingPane threadId="thread-1" conversation={conversation} />);
    const frame = screen.getByLabelText('Message body');
    expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
    expect(frame.getAttribute('srcdoc')).not.toContain('script');
    expect(frame.getAttribute('srcdoc')).not.toContain('onerror');
    await waitFor(() => expect(frame).toHaveAttribute('height', '0'));
  });

  it('preserves plain text and renders an empty body state', () => {
    const conversation = structuredClone(readerFixtures['thread-1']);
    conversation.messages[1].html = null;
    conversation.messages[1].text = 'first line\n  second line';
    const { rerender } = renderWithQueryClient(
      <ReadingPane threadId="thread-1" conversation={conversation} />,
    );
    expect(
      screen.getByText((_, element) => element?.textContent === 'first line\n  second line'),
    ).toHaveClass('whitespace-pre-wrap');
    conversation.messages[1].text = null;
    rerender(<ReadingPane threadId="thread-1" conversation={conversation} />);
    expect(screen.getByText('This message has no content.')).toBeInTheDocument();
  });

  it('mounts the thread ActionRibbon and a per-message ribbon', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ReadingPane threadId="thread-1" />);
    expect(screen.getByRole('toolbar', { name: 'Conversation actions' })).toBeInTheDocument();
    expect(screen.getAllByRole('toolbar', { name: 'Message actions' })).toHaveLength(2);

    await user.click(screen.getAllByRole('button', { name: 'Delete' })[0]);
  });

  it('substitutes the bulk selection panel when a multi-selection is active', () => {
    renderWithQueryClient(<ReadingPane threadId={null} selectedCount={3} />);
    expect(screen.getByTestId('bulk-selection-panel')).toBeInTheDocument();
    expect(screen.getByText('3 conversations selected')).toBeInTheDocument();
  });

  it('routes per-message spam and delete actions to that message', async () => {
    const user = userEvent.setup();
    const onMessageTriage = vi.fn();
    const conversation = {
      ...readerFixtures['thread-1'],
      messages: [{ ...readerFixtures['thread-1'].messages[1], html: null, text: 'Body' }],
    };
    renderWithQueryClient(
      <ReadingPane
        threadId="thread-1"
        conversation={conversation}
        onMessageTriage={onMessageTriage}
      />,
    );
    const ribbon = within(screen.getByRole('toolbar', { name: 'Message actions' }));
    await user.click(ribbon.getByRole('button', { name: 'Mark as spam' }));
    await user.click(ribbon.getByRole('button', { name: 'Delete' }));
    expect(onMessageTriage).toHaveBeenCalledWith('message-2', { kind: 'move', destination: 'SPAM' });
    expect(onMessageTriage).toHaveBeenCalledWith('message-2', { kind: 'delete' });
  });

  it('keeps the full action surface for a thread with one trashed reply among live messages', async () => {
    const conversation = {
      ...readerFixtures['thread-1'],
      messages: [
        { ...readerFixtures['thread-1'].messages[0], labelIds: ['INBOX'] },
        { ...readerFixtures['thread-1'].messages[1], labelIds: ['TRASH'] },
      ],
    };
    renderWithQueryClient(<ReadingPane threadId="thread-1" conversation={conversation} />);
    const ribbon = within(screen.getByRole('toolbar', { name: 'Conversation actions' }));
    expect(ribbon.getByRole('button', { name: 'Star' })).toBeInTheDocument();
    expect(ribbon.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByLabelText('Message body').length).toBeGreaterThan(0));
  });

  it('keeps the full action surface for a thread with one draft reply among live messages', async () => {
    const conversation = {
      ...readerFixtures['thread-1'],
      messages: [
        { ...readerFixtures['thread-1'].messages[0], labelIds: ['INBOX'] },
        { ...readerFixtures['thread-1'].messages[1], labelIds: ['DRAFT'] },
      ],
    };
    renderWithQueryClient(<ReadingPane threadId="thread-1" conversation={conversation} />);
    const ribbon = within(screen.getByRole('toolbar', { name: 'Conversation actions' }));
    expect(ribbon.getByRole('button', { name: 'Star' })).toBeInTheDocument();
    expect(ribbon.getByRole('button', { name: 'Mark as spam' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByLabelText('Message body').length).toBeGreaterThan(0));
  });

  it('derives the thread ribbon from the messages own label membership, not any external mailbox selection', async () => {
    const conversation = {
      ...readerFixtures['thread-1'],
      messages: readerFixtures['thread-1'].messages.map((message) => ({
        ...message,
        labelIds: ['TRASH'],
      })),
    };
    renderWithQueryClient(<ReadingPane threadId="thread-1" conversation={conversation} />);
    const ribbon = within(screen.getByRole('toolbar', { name: 'Conversation actions' }));
    expect(ribbon.queryByRole('button', { name: 'Star' })).not.toBeInTheDocument();
    expect(ribbon.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(await ribbon.findByRole('button', { name: 'Move to' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByLabelText('Message body').length).toBeGreaterThan(0));
  });
});
