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

    // Scoped to the thread ribbon (`action-ribbon`), not the per-message
    // ribbon rendered on each `MessageCard` — both expose a "Move to" button.
    const ribbon = within(await screen.findByTestId('action-ribbon'));
    await user.click(ribbon.getByRole('button', { name: 'Move to' }));
    // `MoveToMenu`'s items are plain buttons in a popper-positioned portal —
    // jsdom's lack of real layout confuses user-event's pointer-target
    // resolution here, so a direct `fireEvent.click` is used instead (same
    // workaround `RowContextMenu.test.tsx` already applies).
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
});
