import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import type { IpcCommandMap } from '@/lib/types/ipc';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { useSyncStore } from '@/stores/sync';

beforeEach(() => {
  act(() => {
    useSelectionStore.setState({
      activeAccountId: null,
      activeMailboxId: null,
      activeThreadId: null,
      keyboardCursor: null,
    });
    useSyncStore.setState({ accountId: null, lastSynced: null, syncState: 'idle' });
  });
});

const accountOne = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};
const accountTwo = {
  id: 'account-2',
  email: 'sam@example.com',
  displayName: 'Sam Rivera',
  avatarUrl: null,
  needsReauthentication: false,
};

const inboxLabel = {
  id: 'INBOX',
  name: 'Inbox',
  kind: 'system',
  color: null,
  messageCount: 1,
  unreadCount: 1,
};
const workLabel = {
  id: 'Label_1',
  name: 'Work',
  kind: 'user',
  color: { text: '#ffffff', background: '#4a86e8' },
  messageCount: 1,
  unreadCount: 0,
};

const threadOne = {
  id: 'thread-1',
  subject: 'Q3 review',
  participants: ['Elena Rodriguez'],
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
      plainBody: null,
      hasAttachments: false,
      isUnread: true,
      isStarred: false,
      labelIds: ['Label_1'],
      remoteImagesBlocked: false,
    },
  ],
} satisfies IpcCommandMap['load_conversation']['result'];

function overrideAccount(id: string, threads: (typeof threadOne)[]) {
  ipc.override('list_labels', ({ accountId }) =>
    accountId === id ? [inboxLabel, workLabel] : [],
  );
  ipc.override('list_threads', ({ accountId }) =>
    accountId === id ? { items: threads, nextCursor: null } : { items: [], nextCursor: null },
  );
}

describe('AppShell wired to real data', () => {
  it('populates the sidebar and inbox from real accounts/labels/threads, and renders a real conversation', async () => {
    ipc.override('list_accounts', [accountOne]);
    overrideAccount('account-1', [threadOne]);
    ipc.override('load_conversation', conversationOne);

    render(<App />);

    expect(await screen.findByText('Work')).toBeInTheDocument();
    expect(await screen.findByText('Q3 review')).toBeInTheDocument();

    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));

    expect(await screen.findByTestId('message-message-1')).toHaveTextContent('Elena Rodriguez');
    expect(screen.getByLabelText('Message body')).toHaveAttribute(
      'srcdoc',
      expect.stringContaining('Attached slides'),
    );
  });

  it('selects the first account and Inbox on a fresh launch without restoring prior selection', async () => {
    ipc.override('list_accounts', [accountOne, accountTwo]);
    overrideAccount('account-1', [threadOne]);

    render(<App />);

    await waitFor(() => expect(useSelectionStore.getState().activeAccountId).toBe('account-1'));
    expect(useSelectionStore.getState().activeMailboxId).toBe('INBOX');
    expect(useSelectionStore.getState().activeThreadId).toBeNull();
  });

  it('switching accounts clears selection and loads the other account inbox', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [accountOne, accountTwo]);
    overrideAccount('account-1', [threadOne]);
    ipc.override('list_labels', ({ accountId }) =>
      accountId === 'account-2' ? [inboxLabel] : [inboxLabel, workLabel],
    );
    ipc.override('list_threads', ({ accountId }) =>
      accountId === 'account-1'
        ? { items: [threadOne], nextCursor: null }
        : { items: [], nextCursor: null },
    );

    render(<App />);
    await screen.findByText('Q3 review');
    await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    expect(useSelectionStore.getState().activeThreadId).toBe('thread-1');

    await user.click(screen.getByRole('button', { name: /Alex Morgan/ }));
    await user.click(within(screen.getByRole('menu')).getByText('sam@example.com'));

    await waitFor(() => expect(useSelectionStore.getState().activeAccountId).toBe('account-2'));
    expect(useSelectionStore.getState().activeMailboxId).toBe('INBOX');
    expect(useSelectionStore.getState().activeThreadId).toBeNull();
    await waitFor(() =>
      expect(screen.getByText('Your Inbox is clear.')).toBeInTheDocument(),
    );
  });

  it('leaves the sign-in screen for the mail layout when sign-in announces the new account', async () => {
    // Regression: a completed OAuth flow that emits nothing leaves the user
    // staring at a stuck "Signing in…" button forever.
    let accounts: (typeof accountOne)[] = [];
    ipc.override('list_accounts', () => accounts);
    overrideAccount('account-1', []);
    act(() => useLayoutStore.setState({ route: 'auth' }));

    render(<App />);
    await screen.findByTestId('sign-in-screen');

    accounts = [accountOne];
    act(() => ipc.emit('account://state', accountOne));

    expect(await screen.findByTestId('mail-layout')).toBeInTheDocument();
  });

  it('makes the reauth banner appear live from an account://state event, without any other user action', async () => {
    // Rust already persisted the flag by the time it emits the event; the
    // event's only job is to nudge the frontend to refetch — so the mocked
    // `list_accounts` command reflects the post-failure state once invoked
    // again, exactly like a real refetch would.
    let accounts = [accountOne];
    ipc.override('list_accounts', () => accounts);
    overrideAccount('account-1', []);

    render(<App />);
    await screen.findByTestId('mail-layout');
    expect(screen.queryByTestId('reauth-banner')).not.toBeInTheDocument();

    accounts = [{ ...accountOne, needsReauthentication: true }];
    act(() => ipc.emit('account://state', accounts[0]));

    expect(await screen.findByTestId('reauth-banner')).toBeInTheDocument();
  });
});
