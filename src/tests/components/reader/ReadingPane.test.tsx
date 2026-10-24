import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReadingPane, readerFixtures } from '@/components/reader/ReadingPane';
import { ipc } from '@/tests/ipc-mock';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { useMessageSourceStore } from '@/stores/message-source';

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
      expect.stringContaining('body{margin:0'),
    );
    await user.click(screen.getByRole('button', { name: 'Expand message from Elena Rodriguez' }));
    expect(screen.getAllByLabelText('Message body')).toHaveLength(2);
    expect(screen.getByText('Remote images are blocked.')).toBeInTheDocument();
  });

  it('holds cached-body space without showing Gmail loading text', async () => {
    const conversation = {
      ...readerFixtures['thread-1'],
      messages: [
        {
          ...readerFixtures['thread-1'].messages[1],
          html: null,
          text: null,
          htmlPresence: 'present' as const,
        },
      ],
    };
    const onFetchBody = vi.fn();
    const readBody = vi.fn(() => new Promise<never>(() => undefined));
    ipc.override('load_message_body', readBody);
    renderWithQueryClient(
      <ReadingPane
        threadId="thread-1"
        conversation={conversation}
        accountId="account-1"
        onFetchBody={onFetchBody}
      />,
    );
    await waitFor(() => expect(readBody).toHaveBeenCalledOnce());
    expect(screen.queryByText('Loading message…')).not.toBeInTheDocument();
    expect(
      screen.getByTestId('message-message-2').querySelector('.min-h-reader-body'),
    ).toBeInTheDocument();
    expect(onFetchBody).not.toHaveBeenCalled();
  });

  it('sanitizes HTML before it reaches the script-free iframe', async () => {
    const conversation = structuredClone(readerFixtures['thread-1']);
    conversation.messages[1].html =
      '<p>Safe</p><script>window.bad = true</script><img src=x onerror="window.bad = true">';
    renderWithQueryClient(<ReadingPane threadId="thread-1" conversation={conversation} />);
    const frame = screen.getByLabelText('Message body');
    expect(frame).not.toHaveAttribute('sandbox');
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
    expect(onMessageTriage).toHaveBeenCalledWith('message-2', {
      kind: 'move',
      destination: 'SPAM',
    });
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

  it('offers source and export actions on sent messages but not on drafts', async () => {
    const user = userEvent.setup();
    const savedTo: string[] = [];
    const defaultPaths: string[] = [];
    ipc.override('plugin:dialog|save', ({ options }) => {
      defaultPaths.push(options.defaultPath ?? '');
      return '/Users/me/Downloads/export';
    });
    ipc.override('save_message_source_to_path', ({ messageId }) => {
      savedTo.push(`eml:${messageId}`);
    });
    ipc.override('save_message_html_to_path', ({ messageId }) => {
      savedTo.push(`html:${messageId}`);
    });
    useMessageSourceStore.setState({ target: null });
    const conversation = {
      ...readerFixtures['thread-1'],
      messages: [
        { ...readerFixtures['thread-1'].messages[0], isDraft: false },
        { ...readerFixtures['thread-1'].messages[1], isDraft: true },
      ],
    };
    renderWithQueryClient(
      <ReadingPane threadId="thread-1" conversation={conversation} accountId="account-1" />,
    );
    expect(screen.getAllByRole('button', { name: 'More message actions' })).toHaveLength(1);
    const ribbon = within(screen.getAllByRole('toolbar', { name: 'Message actions' })[0]);

    await user.click(ribbon.getByRole('button', { name: 'More message actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Show original/ }));
    expect(useMessageSourceStore.getState().target).toEqual({
      accountId: 'account-1',
      messageId: 'message-1',
    });
    await user.click(ribbon.getByRole('button', { name: 'More message actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download message (.eml)' }));
    await user.click(ribbon.getByRole('button', { name: 'More message actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download as web page (.html)' }));

    await waitFor(() => expect(savedTo).toEqual(['eml:message-1', 'html:message-1']));
    expect(defaultPaths[0]).toMatch(/^\d{4}-\d{2}-\d{2} Q3 Marketing Strategy Review\.eml$/);
    act(() => useMessageSourceStore.setState({ target: null }));
  });

  it('offers no export actions without an account', () => {
    renderWithQueryClient(<ReadingPane threadId="thread-1" />);
    expect(screen.queryByRole('button', { name: 'More message actions' })).not.toBeInTheDocument();
  });
});
