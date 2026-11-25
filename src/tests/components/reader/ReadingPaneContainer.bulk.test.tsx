import { getTime, parseISO } from 'date-fns';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';
import { ipc } from '@/tests/ipc-mock';
import {
  renderWithClient,
  resetReadingPaneSearchStore,
} from '@/tests/components/reader/reading-pane-helpers';

const SELECTED_THREAD_COUNT = 2;

afterEach(() => resetReadingPaneSearchStore());

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
        latestAt: getTime(parseISO('2026-08-11T10:00:00Z')),
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
        latestAt: getTime(parseISO('2026-08-11T10:00:00Z')),
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
        latestAt: getTime(parseISO('2026-08-10T10:00:00Z')),
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

it('shows each label in its own colour in the bulk selection labels menu', async () => {
  const user = userEvent.setup();
  useSelectionStore.setState({
    activeAccountId: 'account-1',
    activeMailboxId: 'INBOX',
    activeThreadId: null,
    keyboardCursor: null,
  });
  useMultiSelectStore.setState({
    selectedIds: new Set(['thread-one', 'thread-two']),
    anchorId: null,
  });
  ipc.override('list_labels', [
    {
      id: 'Label_1',
      name: 'Projects',
      kind: 'user',
      color: { background: '#434343', text: '#ffffff' },
      messageCount: 2,
      unreadCount: 0,
    },
  ]);
  ipc.override('list_threads', {
    items: ['thread-one', 'thread-two'].map((id) => ({
      id: id,
      subject: id,
      sender: { display: 'Anna', address: 'anna@example.com' },
      sentRecipient: null,
      latestAt: getTime(parseISO('2026-08-11T10:00:00Z')),
      messageCount: 1,
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
      hasDraft: false,
      systemLabelIds: ['INBOX'],
    })),
    nextCursor: null,
  });

  renderWithClient();

  const panel = await screen.findByTestId('bulk-selection-panel');
  await user.click(within(panel).getByRole('button', { name: 'Labels' }));
  const entry = await screen.findByRole('menuitemcheckbox', { name: /Projects/ });
  expect(entry.querySelector('.size-chip-dot')).toHaveClass('bg-label-gmail-1');
});

it('keeps the bulk selection after a bulk action so more actions can follow', async () => {
  const user = userEvent.setup();
  useSelectionStore.setState({
    activeAccountId: 'account-1',
    activeMailboxId: 'INBOX',
    activeThreadId: null,
    keyboardCursor: null,
  });
  useMultiSelectStore.setState({
    selectedIds: new Set(['thread-a', 'thread-b']),
    anchorId: null,
  });
  const threadChanges: unknown[] = [];
  ipc.override('list_threads', {
    items: ['thread-a', 'thread-b'].map((id, index) => ({
      id: id,
      subject: `Subject ${id}`,
      sender: { display: `Sender ${id}`, address: `${id}@example.com` },
      sentRecipient: null,
      latestAt: getTime(parseISO('2026-08-11T10:00:00Z')) - index,
      messageCount: 1,
      isUnread: false,
      isStarred: false,
      hasAttachments: false,
      hasDraft: false,
      systemLabelIds: ['INBOX'],
    })),
    nextCursor: null,
  });
  ipc.override('mutate_threads', (request) => {
    threadChanges.push(request);
    return [];
  });

  renderWithClient();

  const panel = within(await screen.findByTestId('bulk-selection-panel'));
  await user.click(panel.getByRole('button', { name: 'Star' }));
  await waitFor(() => expect(threadChanges).toHaveLength(1));
  expect(threadChanges).toEqual([
    expect.objectContaining({ threadIds: ['thread-a', 'thread-b'], add: ['STARRED'] }),
  ]);
  expect(useMultiSelectStore.getState().selectedIds.size).toBe(SELECTED_THREAD_COUNT);
  expect(
    within(await screen.findByTestId('bulk-selection-panel')).getByText('2 conversations selected'),
  ).toBeInTheDocument();
});
