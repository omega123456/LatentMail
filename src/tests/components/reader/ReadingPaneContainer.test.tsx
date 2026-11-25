import { getTime, parseISO } from 'date-fns';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { EventBridge } from '@/lib/query/event-bridge';
import type { MessageBody } from '@/lib/types/ipc';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';
import { captureConsole } from '@/tests/console';
import {
  conversationFor,
  renderWithClient,
  resetReadingPaneSearchStore,
  selectAccount,
} from '@/tests/components/reader/reading-pane-helpers';

const LABEL_CHANGE_COUNT = 2;

describe('ReadingPaneContainer', () => {
  afterEach(() => resetReadingPaneSearchStore());

  it('reads a cached body locally without requesting Gmail', async () => {
    selectAccount();
    const readBody = vi.fn(() => ({
      htmlBody: '<p>Cached</p>',
      plainBody: null,
      htmlPresence: 'present' as const,
      truncated: false,
      remoteImagesBlocked: false,
      remoteImagesAllowed: false,
      inlineImagesPending: false,
    }));
    const fetchBody = vi.fn();
    ipc.override('list_accounts', [
      {
        id: 'account-1',
        email: 'me@example.com',
        displayName: 'Me',
        avatarUrl: null,
        needsReauthentication: false,
      },
    ]);
    ipc.override('load_conversation', conversationFor('present'));
    ipc.override('load_message_body', readBody);
    ipc.override('fetch_message_body', fetchBody);
    renderWithClient();
    await screen.findByLabelText('Message body');
    expect(readBody).toHaveBeenCalledOnce();
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('uses Gmail for a never-fetched body and skips too-large bodies entirely', async () => {
    selectAccount();
    const fetchBody = vi.fn();
    const readBody = vi.fn(() => ({
      htmlBody: null,
      plainBody: null,
      htmlPresence: 'neverFetched' as const,
      truncated: false,
      remoteImagesBlocked: false,
      remoteImagesAllowed: false,
      inlineImagesPending: false,
    }));
    ipc.override('load_conversation', conversationFor('neverFetched'));
    ipc.override('load_message_body', readBody);
    ipc.override('fetch_message_body', fetchBody);
    const first = renderWithClient();
    await waitFor(() =>
      expect(fetchBody).toHaveBeenCalledWith({ accountId: 'account-1', messageId: 'message-1' }),
    );
    first.unmount();
    readBody.mockClear();
    fetchBody.mockClear();
    ipc.override('load_conversation', conversationFor('tooLarge'));
    renderWithClient();
    await screen.findByText('This message is too big to open here.');
    expect(readBody).not.toHaveBeenCalled();
    expect(fetchBody).not.toHaveBeenCalled();
  });

  it('renders a never-fetched body once the fetch event refreshes the cached body', async () => {
    const consoleInfo = captureConsole('info');
    selectAccount();
    let stored: MessageBody = {
      htmlBody: null,
      plainBody: null,
      htmlPresence: 'neverFetched',
      truncated: false,
      remoteImagesBlocked: false,
      remoteImagesAllowed: false,
      inlineImagesPending: false,
    };
    ipc.override('load_conversation', conversationFor('neverFetched'));
    ipc.override('load_message_body', () => stored);
    ipc.override('fetch_message_body', () => {
      stored = { ...stored, htmlBody: '<p>Fetched body</p>', htmlPresence: 'present' };
    });
    const client = new QueryClient();
    render(
      <QueryClientProvider client={client}>
        <EventBridge />
        <ReadingPaneContainer threadId="thread-1" />
      </QueryClientProvider>,
    );
    await screen.findByText('Loading message…');
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('message://body-fetched', expect.any(Function)),
    );
    act(() =>
      ipc.emit('message://body-fetched', { accountId: 'account-1', messageId: 'message-1' }),
    );
    await screen.findByLabelText('Message body');
    expect(screen.queryByText('Loading message…')).not.toBeInTheDocument();
    expect(consoleInfo).toHaveBeenCalledWith(
      'event message://body-fetched {"accountId":"account-1","messageId":"message-1"}',
    );
  });

  it('never removes a user label when moving a thread found through a user-label mailbox', async () => {
    const user = userEvent.setup();
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'Label_1',
      activeThreadId: 'thread-1',
      keyboardCursor: null,
    });
    useMultiSelectStore.setState({ selectedIds: new Set(), anchorId: null });
    ipc.override('list_labels', [
      {
        id: 'Label_1',
        name: 'Marketing',
        kind: 'user',
        color: { text: '#ffffff', background: '#4a86e8' },
        messageCount: 1,
        unreadCount: 0,
      },
    ]);
    ipc.override('load_conversation', {
      threadId: 'thread-1',
      subject: 'Q3 Marketing Strategy Review',
      messages: [
        {
          id: 'message-1',
          sender: 'Elena Rodriguez <elena.r@example.com>',
          recipients: ['you@example.com'],
          subject: 'Q3 Marketing Strategy Review',
          sentAt: getTime(parseISO('2026-08-10T09:00:00Z')),
          snippet: 'Attached the slides.',
          htmlBody: '<p>Attached the slides.</p>',
          htmlPresence: 'present',
          truncated: false,
          plainBody: null,
          hasAttachments: false,
          isUnread: false,
          isStarred: false,
          labelIds: ['Label_1'],
          remoteImagesBlocked: false,
          remoteImagesAllowed: false,
          inlineImagesPending: false,
          attachments: [],
        },
      ],
    });

    let moveArgs: unknown;
    ipc.override('move_threads', (request) => {
      moveArgs = request;
      return [];
    });

    renderWithClient();

    const ribbon = within(await screen.findByTestId('action-ribbon'));
    await user.click(ribbon.getByRole('button', { name: 'Move to' }));

    fireEvent.click(await screen.findByRole('menuitem', { name: /Inbox/ }));

    await waitFor(() =>
      expect(moveArgs).toMatchObject({
        accountId: 'account-1',
        threadIds: ['thread-1'],
        destination: 'INBOX',
      }),
    );
  });

  it('wires read, star, spam, and delete thread actions to their respective mutations', async () => {
    const user = userEvent.setup();
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: 'thread-1',
      keyboardCursor: null,
    });
    useMultiSelectStore.setState({ selectedIds: new Set(), anchorId: null });
    const labelChanges: unknown[] = [];
    const moveChanges: unknown[] = [];
    const deleteChanges: unknown[] = [];
    ipc.override('mutate_threads', (request) => {
      labelChanges.push(request);
      return [];
    });
    ipc.override('move_threads', (request) => {
      moveChanges.push(request);
      return [];
    });
    ipc.override('delete_threads', (request) => {
      deleteChanges.push(request);
      return [];
    });
    renderWithClient();
    const ribbon = within(await screen.findByTestId('action-ribbon'));
    await user.click(ribbon.getByRole('button', { name: 'Mark unread' }));
    await user.click(ribbon.getByRole('button', { name: 'Star' }));
    await user.click(ribbon.getByRole('button', { name: 'Mark as spam' }));
    await user.click(ribbon.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(labelChanges).toHaveLength(LABEL_CHANGE_COUNT));
    await waitFor(() => expect(moveChanges).toHaveLength(1));
    await waitFor(() => expect(deleteChanges).toHaveLength(1));
    expect(labelChanges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ add: ['UNREAD'], remove: [] }),
        expect.objectContaining({ add: ['STARRED'], remove: [] }),
      ]),
    );
    expect(moveChanges).toEqual([
      expect.objectContaining({ threadIds: ['thread-1'], destination: 'SPAM' }),
    ]);
    expect(deleteChanges).toEqual([expect.objectContaining({ threadIds: ['thread-1'] })]);
  });

  it('wires per-message spam and delete actions to the message-scoped intent commands', async () => {
    const consoleInfo = captureConsole('info');
    const user = userEvent.setup();
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: 'thread-1',
      keyboardCursor: null,
    });
    useMultiSelectStore.setState({ selectedIds: new Set(), anchorId: null });
    ipc.override('load_conversation', {
      threadId: 'thread-1',
      subject: 'Q3 Marketing Strategy Review',
      messages: [
        {
          id: 'message-1',
          sender: 'Elena Rodriguez <elena.r@example.com>',
          recipients: ['you@example.com'],
          subject: 'Q3 Marketing Strategy Review',
          sentAt: getTime(parseISO('2026-08-10T09:00:00Z')),
          snippet: 'Attached the slides.',
          htmlBody: '<p>Attached the slides.</p>',
          htmlPresence: 'present',
          truncated: false,
          plainBody: null,
          hasAttachments: false,
          isUnread: false,
          isStarred: false,
          labelIds: ['INBOX'],
          remoteImagesBlocked: false,
          remoteImagesAllowed: false,
          inlineImagesPending: false,
          attachments: [],
        },
      ],
    });
    const moveMessageChanges: unknown[] = [];
    const deleteMessageChanges: unknown[] = [];
    ipc.override('move_messages', (request) => {
      moveMessageChanges.push(request);
      ipc.emit('mail://changed', { accountId: 'account-1' });
      return undefined;
    });
    ipc.override('delete_messages', (request) => {
      deleteMessageChanges.push(request);
      ipc.emit('mail://changed', { accountId: 'account-1' });
      return undefined;
    });
    renderWithClient({ bridged: true });
    const ribbon = within(await screen.findByTestId('message-action-ribbon'));
    await user.click(ribbon.getByRole('button', { name: 'Mark as spam' }));
    await user.click(ribbon.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(moveMessageChanges).toHaveLength(1));
    await waitFor(() => expect(deleteMessageChanges).toHaveLength(1));
    expect(moveMessageChanges).toEqual([
      expect.objectContaining({ messageIds: ['message-1'], destination: 'SPAM' }),
    ]);
    expect(deleteMessageChanges).toEqual([expect.objectContaining({ messageIds: ['message-1'] })]);
    expect(consoleInfo).toHaveBeenCalledWith('event mail://changed {"accountId":"account-1"}');
  });
});
