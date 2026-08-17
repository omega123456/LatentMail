import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { useSelectionStore } from '@/stores/selection';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSearchStore } from '@/stores/search';
import { ipc } from '@/tests/ipc-mock';

function renderWithClient() {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <ReadingPaneContainer threadId="thread-1" />
    </QueryClientProvider>,
  );
}

describe('ReadingPaneContainer', () => {
  afterEach(() =>
    act(() =>
      useSearchStore.setState({
        draft: '',
        submittedQuery: '',
        scope: { kind: 'default' },
        active: false,
        panelOpen: false,
      }),
    ),
  );

  it('resolves bulk selection state from the search results list while search is active, not the mailbox listing', async () => {
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: null,
      keyboardCursor: null,
    });
    useSearchStore.setState({
      draft: 'from:anna',
      submittedQuery: 'from:anna',
      scope: { kind: 'default' },
      active: true,
      panelOpen: false,
    });
    useMultiSelectStore.setState({ selectedIds: new Set(['thread-search-1']), anchorId: null });
    ipc.override('list_threads', { items: [], nextCursor: null });
    ipc.override('search_threads', {
      items: [
        {
          id: 'thread-search-1',
          subject: 'Found via search',
          sender: { display: 'Anna', address: 'anna@example.com' },
          sentRecipient: null,
          latestAt: Date.parse('2026-08-11T10:00:00Z'),
          messageCount: 1,
          isUnread: true,
          isStarred: true,
          hasAttachments: false,
          hasDraft: false,
          systemLabelIds: ['SPAM'],
        },
      ],
      nextCursor: null,
      total: 1,
    });

    renderWithClient();

    const panel = await screen.findByTestId('bulk-selection-panel');
    expect(within(panel).getByText('1 conversation selected')).toBeInTheDocument();
    const ribbon = within(panel);
    expect(await ribbon.findByRole('button', { name: 'Unstar' })).toBeInTheDocument();
    expect(await ribbon.findByRole('button', { name: 'Not spam' })).toBeInTheDocument();
  });

  it('disables a Move to destination for a bulk selection only when every selected thread already carries it', async () => {
    const user = userEvent.setup();
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: null,
      keyboardCursor: null,
    });
    useMultiSelectStore.setState({
      selectedIds: new Set(['thread-trash', 'thread-inbox']),
      anchorId: null,
    });
    ipc.override('list_threads', {
      items: [
        {
          id: 'thread-trash',
          subject: 'In trash',
          sender: { display: 'Anna', address: 'anna@example.com' },
          sentRecipient: null,
          latestAt: Date.parse('2026-08-11T10:00:00Z'),
          messageCount: 1,
          isUnread: false,
          isStarred: false,
          hasAttachments: false,
          hasDraft: false,
          systemLabelIds: ['TRASH'],
        },
        {
          id: 'thread-inbox',
          subject: 'In inbox',
          sender: { display: 'Bob', address: 'bob@example.com' },
          sentRecipient: null,
          latestAt: Date.parse('2026-08-10T10:00:00Z'),
          messageCount: 1,
          isUnread: false,
          isStarred: false,
          hasAttachments: false,
          hasDraft: false,
          systemLabelIds: ['INBOX'],
        },
      ],
      nextCursor: null,
    });

    renderWithClient();

    const panel = await screen.findByTestId('bulk-selection-panel');
    await user.click(within(panel).getByRole('button', { name: 'Move to' }));
    expect(await screen.findByRole('menuitem', { name: /Trash/ })).toBeEnabled();
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
          sentAt: Date.parse('2026-08-10T09:00:00Z'),
          snippet: 'Attached the slides.',
          htmlBody: '<p>Attached the slides.</p>',
          htmlPresence: 'present',
          plainBody: null,
          hasAttachments: false,
          isUnread: false,
          isStarred: false,
          labelIds: ['Label_1'],
          remoteImagesBlocked: false,
        },
      ],
    });

    let moveArgs: unknown;
    ipc.override('move_threads', (args) => {
      moveArgs = args;
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
    ipc.override('mutate_threads', (args) => {
      labelChanges.push(args);
      return [];
    });
    ipc.override('move_threads', (args) => {
      moveChanges.push(args);
      return [];
    });
    ipc.override('delete_threads', (args) => {
      deleteChanges.push(args);
      return [];
    });
    renderWithClient();
    const ribbon = within(await screen.findByTestId('action-ribbon'));
    await user.click(ribbon.getByRole('button', { name: 'Mark unread' }));
    await user.click(ribbon.getByRole('button', { name: 'Star' }));
    await user.click(ribbon.getByRole('button', { name: 'Mark as spam' }));
    await user.click(ribbon.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(labelChanges).toHaveLength(2));
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
          sentAt: Date.parse('2026-08-10T09:00:00Z'),
          snippet: 'Attached the slides.',
          htmlBody: '<p>Attached the slides.</p>',
          htmlPresence: 'present',
          plainBody: null,
          hasAttachments: false,
          isUnread: false,
          isStarred: false,
          labelIds: ['INBOX'],
          remoteImagesBlocked: false,
        },
      ],
    });
    const moveMessageChanges: unknown[] = [];
    const deleteMessageChanges: unknown[] = [];
    ipc.override('move_messages', (args) => {
      moveMessageChanges.push(args);
      return undefined;
    });
    ipc.override('delete_messages', (args) => {
      deleteMessageChanges.push(args);
      return undefined;
    });
    renderWithClient();
    const ribbon = within(await screen.findByTestId('message-action-ribbon'));
    await user.click(ribbon.getByRole('button', { name: 'Mark as spam' }));
    await user.click(ribbon.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(moveMessageChanges).toHaveLength(1));
    await waitFor(() => expect(deleteMessageChanges).toHaveLength(1));
    expect(moveMessageChanges).toEqual([
      expect.objectContaining({ messageIds: ['message-1'], destination: 'SPAM' }),
    ]);
    expect(deleteMessageChanges).toEqual([expect.objectContaining({ messageIds: ['message-1'] })]);
  });
});
