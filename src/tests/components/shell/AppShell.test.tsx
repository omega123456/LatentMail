import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/App';
import type { IpcCommandMap } from '@/lib/types/ipc';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';
import { useSyncStore } from '@/stores/sync';
import { useSettingsUiStore } from '@/stores/settings-ui';

beforeEach(() => {
  act(() => {
    useSelectionStore.setState({
      activeAccountId: null,
      activeMailboxId: null,
      activeThreadId: null,
      keyboardCursor: null,
    });
    useSyncStore.setState({ accountId: null, lastSynced: null, syncState: 'idle' });
    useLayoutStore.setState({
      route: 'mail',
      layout: 'three-column',
      sidebarCollapsed: false,
      sidebarWidth: 260,
      listWidth: 350,
      readerHeight: 40,
    });
    useSearchStore.setState({
      draft: '',
      submittedQuery: '',
      scope: { kind: 'default' },
      active: false,
      panelOpen: false,
    });
    useSettingsUiStore.setState({ activeSection: 'general' });
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
  ipc.override('list_labels', ({ accountId }) => (accountId === id ? [inboxLabel, workLabel] : []));
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
    await waitFor(() => expect(screen.getByText('Your Inbox is clear.')).toBeInTheDocument());
  });

  it('leaves the sign-in screen for the mail layout when sign-in announces the new account', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    let accounts: (typeof accountOne)[] = [];
    ipc.override('list_accounts', () => accounts);
    overrideAccount('account-1', []);
    act(() => useLayoutStore.setState({ route: 'auth' }));

    render(<App />);
    await screen.findByTestId('sign-in-screen');

    accounts = [accountOne];
    act(() => ipc.emit('account://state', accountOne));

    expect(await screen.findByTestId('mail-layout')).toBeInTheDocument();
    log.mockRestore();
  });

  it('makes the reauth banner appear live from an account://state event, without any other user action', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);

    let accounts = [accountOne];
    ipc.override('list_accounts', () => accounts);
    overrideAccount('account-1', []);

    render(<App />);
    await screen.findByTestId('mail-layout');
    expect(screen.queryByTestId('reauth-banner')).not.toBeInTheDocument();

    accounts = [{ ...accountOne, needsReauthentication: true }];
    act(() => ipc.emit('account://state', accounts[0]));

    expect(await screen.findByTestId('reauth-banner')).toBeInTheDocument();
    log.mockRestore();
  });

  it('handles sidebar, mailbox, settings, and pane controls through the live layout', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [accountOne]);
    overrideAccount('account-1', [threadOne]);
    render(<App />);
    await screen.findByText('Q3 review');

    await user.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(screen.getByTestId('collapsed-rail')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand sidebar' }));
    expect(screen.getByTestId('sidebar-slot')).toBeInTheDocument();

    const inbox = screen.getAllByText('Inbox').find((element) => element.closest('button'))!;
    await user.click(inbox.closest('button')!);
    expect(useSelectionStore.getState().activeMailboxId).toBe('INBOX');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize conversation list' }), {
      clientX: 10,
    });
    fireEvent.pointerMove(window, { clientX: 30 });
    fireEvent.pointerUp(window);
    expect(useLayoutStore.getState().listWidth).toBe(370);

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    expect(await screen.findByTestId('settings-shell')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'General' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to Mail' })).toBeInTheDocument();
  });

  it('returns from Settings to Mail with the active account, mailbox, selection and search intact', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [accountOne]);
    overrideAccount('account-1', [threadOne]);
    render(<App />);
    await screen.findByText('Q3 review');

    act(() => {
      useSelectionStore.setState({ activeThreadId: 'thread-1', keyboardCursor: 0 });
      useSearchStore.setState({
        draft: 'from:anna',
        submittedQuery: 'from:anna',
        scope: { kind: 'default' },
        active: true,
        panelOpen: false,
      });
    });

    const before = {
      selection: useSelectionStore.getState(),
      search: useSearchStore.getState(),
    };

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByTestId('settings-shell');
    await user.click(screen.getByRole('button', { name: 'Back to Mail' }));
    await screen.findByTestId('mail-layout');

    expect(useSelectionStore.getState()).toEqual(before.selection);
    expect(useSearchStore.getState()).toEqual(before.search);
  });

  it('remembers the last viewed settings section for the app session', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [accountOne]);
    overrideAccount('account-1', [threadOne]);
    render(<App />);
    await screen.findByText('Q3 review');

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByTestId('settings-shell');
    await user.click(screen.getByRole('button', { name: 'Queue' }));
    expect(await screen.findByRole('heading', { name: 'Queue' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to Mail' }));
    await screen.findByTestId('mail-layout');

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByTestId('settings-shell');
    expect(screen.getByRole('heading', { name: 'Queue' })).toBeInTheDocument();
  });

  it('renders no Save, Apply or Cancel control in General', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [accountOne]);
    overrideAccount('account-1', [threadOne]);
    render(<App />);
    await screen.findByText('Q3 review');

    await user.click(screen.getByRole('button', { name: 'Settings' }));
    await screen.findByRole('heading', { name: 'General' });

    expect(screen.queryByRole('button', { name: /save/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /apply/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
  });

  it('resizes the bottom preview reader', async () => {
    ipc.override('list_accounts', [accountOne]);
    overrideAccount('account-1', [threadOne]);
    render(<App />);
    await screen.findByText('Q3 review');
    act(() => {
      useLayoutStore.getState().setLayout('bottom-preview');
      useSelectionStore.setState({ activeThreadId: 'thread-1' });
    });
    await screen.findByRole('button', { name: 'Resize reader' });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize reader' }), { clientY: 10 });
    fireEvent.pointerMove(window, { clientY: 30 });
    fireEvent.pointerUp(window);
    expect(useLayoutStore.getState().readerHeight).toBe(80);
  });
});
