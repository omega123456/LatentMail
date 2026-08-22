import { act, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import type { IpcCommandMap } from '@/lib/types/ipc';

const account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

const inboxLabel = {
  id: 'INBOX',
  name: 'Inbox',
  kind: 'system',
  color: null,
  messageCount: 1,
  unreadCount: 3,
};

const threadOne = {
  id: 'thread-1',
  subject: 'Q3 review',
  sender: { display: 'Elena Rodriguez', address: 'elena.r@example.com' },
  sentRecipient: null,
  latestAt: Date.parse('2026-08-10T09:00:00Z'),
  messageCount: 1,
  isUnread: true,
  isStarred: false,
  hasAttachments: false,
  hasDraft: false,
};

const conversationOne = {
  threadId: 'thread-1',
  subject: 'Q3 review',
  messages: [
    {
      id: 'message-1',
      sender: 'Elena Rodriguez <elena.r@example.com>',
      recipients: ['You <you@example.com>'],
      subject: 'Q3 review',
      sentAt: Date.parse('2026-08-10T09:00:00Z'),
      snippet: 'Attached slides',
      htmlBody: '<p>Attached slides</p>',
      htmlPresence: 'present',
      truncated: false,
      plainBody: null,
      hasAttachments: false,
      isUnread: true,
      isStarred: false,
      labelIds: [],
      remoteImagesBlocked: false,
      remoteImagesAllowed: false,
      inlineImagesPending: false,
      attachments: [],
    },
  ],
} satisfies IpcCommandMap['load_conversation']['result'];

describe('mail surface reactivity to General settings', () => {
  it('hides the sidebar unread count as soon as showUnreadCounts is toggled, without remounting', async () => {
    ipc.override('list_accounts', [account]);
    ipc.override('list_labels', [inboxLabel]);
    ipc.override('list_threads', { items: [threadOne], nextCursor: null });

    render(<App />);
    await screen.findByText('Q3 review');
    expect(screen.getByText('3')).toBeInTheDocument();

    act(() => useLayoutStore.getState().setShowUnreadCounts(false));

    expect(screen.queryByText('3')).not.toBeInTheDocument();
    expect(await screen.findByText('Q3 review')).toBeInTheDocument();
  });

  it('hides the sender avatar in the reading pane as soon as showSenderAvatars is toggled, without remounting', async () => {
    ipc.override('list_accounts', [account]);
    ipc.override('list_labels', [inboxLabel]);
    ipc.override('list_threads', { items: [threadOne], nextCursor: null });
    ipc.override('load_conversation', conversationOne);

    render(<App />);
    await screen.findByText('Q3 review');
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    const message = await screen.findByTestId('message-message-1');
    expect(within(message).getByText('E')).toBeInTheDocument();

    act(() => useLayoutStore.getState().setShowSenderAvatars(false));

    expect(within(message).queryByText('E')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-message-1')).toBeInTheDocument();
  });
});
