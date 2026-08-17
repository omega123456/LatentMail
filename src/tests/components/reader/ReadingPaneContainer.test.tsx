import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ReadingPaneContainer } from '@/components/reader/ReadingPane';
import { useSelectionStore } from '@/stores/selection';
import { useMultiSelectStore } from '@/stores/multi-select';
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
  it('removes the current user label as the "Move to" source when browsing a user-label mailbox via the thread ribbon', async () => {
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

    let mutateArgs: unknown;
    ipc.override('mutate_threads', (args) => {
      mutateArgs = args;
      return [];
    });

    renderWithClient();


    const ribbon = within(await screen.findByTestId('action-ribbon'));
    await user.click(ribbon.getByRole('button', { name: 'Move to' }));

    fireEvent.click(await screen.findByRole('menuitem', { name: /Inbox/ }));

    await waitFor(() =>
      expect(mutateArgs).toMatchObject({
        accountId: 'account-1',
        threadIds: ['thread-1'],
        add: ['INBOX'],
        remove: ['Label_1'],
      }),
    );
  });

  it('wires read, star, spam, and delete thread actions to triage mutations', async () => {
    const user = userEvent.setup();
    useSelectionStore.setState({
      activeAccountId: 'account-1',
      activeMailboxId: 'INBOX',
      activeThreadId: 'thread-1',
      keyboardCursor: null,
    });
    useMultiSelectStore.setState({ selectedIds: new Set(), anchorId: null });
    const changes: unknown[] = [];
    ipc.override('mutate_threads', (args) => {
      changes.push(args);
      return [];
    });
    renderWithClient();
    const ribbon = within(await screen.findByTestId('action-ribbon'));
    await user.click(ribbon.getByRole('button', { name: 'Mark unread' }));
    await user.click(ribbon.getByRole('button', { name: 'Star' }));
    await user.click(ribbon.getByRole('button', { name: 'Mark as spam' }));
    await user.click(ribbon.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(changes).toHaveLength(4));
    expect(changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ add: ['UNREAD'], remove: [] }),
        expect.objectContaining({ add: ['STARRED'], remove: [] }),
        expect.objectContaining({ add: ['SPAM'], remove: [] }),
        expect.objectContaining({ add: ['TRASH'], remove: [] }),
      ]),
    );
  });
});
