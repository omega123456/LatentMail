import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import { useSyncStore } from '@/stores/sync';
import { useComposeStore } from '@/stores/compose';

beforeEach(() => {
  act(() => {
    useSelectionStore.setState({
      activeAccountId: null,
      activeMailboxId: null,
      activeThreadId: null,
      keyboardCursor: null,
    });
    useSyncStore.setState({ accountId: null, lastSynced: null, syncState: 'idle' });
    useSearchStore.setState({
      draft: '',
      submittedQuery: '',
      scope: { kind: 'default' },
      active: false,
      panelOpen: false,
    });
  });
});

const account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

const workLabel = {
  id: 'Label_1',
  name: 'Work',
  kind: 'user',
  color: { text: '#ffffff', background: '#4a86e8' },
  messageCount: 1,
  unreadCount: 0,
};

describe('MailLayout — label lifecycle wiring', () => {
  it('creates a label through the real create_label IPC command', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    ipc.override('list_labels', [workLabel]);
    let created: unknown;
    ipc.override('create_label', (args) => {
      created = args;
      return { ...workLabel, id: 'Label_2', name: (args as { name: string }).name };
    });
    render(<App />);
    await screen.findByText('Work');
    await user.click(screen.getByRole('button', { name: 'Create label' }));
    await user.type(screen.getByPlaceholderText('Label name'), 'Contracts');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(created).toMatchObject({ accountId: 'account-1', name: 'Contracts' }),
    );
  });

  it('renames and deletes a label through the real IPC commands', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    ipc.override('list_labels', [workLabel]);
    let renamed: unknown;
    let deleted: unknown;
    ipc.override('rename_label', (args) => {
      renamed = args;
      return { ...workLabel, name: (args as { name: string }).name };
    });
    ipc.override('delete_label', (args) => {
      deleted = args;
      return undefined;
    });
    render(<App />);
    await screen.findByText('Work');

    await user.click(screen.getByRole('button', { name: 'Edit Work' }));
    const input = screen.getByDisplayValue('Work');
    await user.clear(input);
    await user.type(input, 'Projects');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(renamed).toMatchObject({
        accountId: 'account-1',
        labelId: 'Label_1',
        name: 'Projects',
      }),
    );

    await user.click(screen.getByRole('button', { name: 'Delete Work' }));
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() =>
      expect(deleted).toMatchObject({ accountId: 'account-1', labelId: 'Label_1' }),
    );
  });
});

describe('MailLayout — composer mounting', () => {
  beforeEach(() => act(() => useComposeStore.getState().close()));

  it('mounts the composer over the mail surface, openable by driving the compose store directly', async () => {
    ipc.override('list_accounts', [account]);
    render(<App />);
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    act(() => {
      useComposeStore.getState().open({
        id: 'session-1',
        mode: 'new',
        accountId: 'account-1',
        from: 'alex@example.com',
        recipients: { to: [], cc: [], bcc: [] },
        subject: '',
        html: '',
      });
    });
    expect(await screen.findByRole('dialog', { name: 'New Message' })).toBeInTheDocument();
  });

  it('opens a blank composer from the expanded Compose control', async () => {
    ipc.override('list_accounts', [account]);
    render(<App />);
    const compose = await screen.findByRole('button', { name: 'Compose' });
    await userEvent.setup().click(compose);
    expect(useComposeStore.getState().session).toMatchObject({ mode: 'new' });
  });
});

const searchResultThread = {
  id: 'thread-search-1',
  subject: 'Q3 invoice',
  sender: { display: 'Anna', address: 'anna@example.com' },
  sentRecipient: null,
  latestAt: Date.parse('2026-08-11T10:42:00Z'),
  messageCount: 1,
  isUnread: false,
  isStarred: false,
  hasAttachments: true,
  hasDraft: false,
  snippet: 'Attached is the invoice.',
  labelIndicators: [],
  systemLabelIds: ['SENT'],
};

describe('MailLayout — search', () => {
  beforeEach(() => act(() => useComposeStore.getState().close()));

  it('focuses the search field with Cmd/Ctrl+F and with /, from Mail', async () => {
    ipc.override('list_accounts', [account]);
    render(<App />);
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    act(() =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', metaKey: true })),
    );
    expect(screen.getByLabelText('Search mail')).toHaveFocus();
    (document.activeElement as HTMLElement)?.blur();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '/' })));
    expect(screen.getByLabelText('Search mail')).toHaveFocus();
  });

  it('submits on Enter, shows the sidebar row with the true total, and clears selection without touching activeMailboxId', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    ipc.override('search_threads', { items: [searchResultThread], nextCursor: null, total: 7 });
    render(<App />);
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    const field = screen.getByLabelText('Search mail');
    await user.click(field);
    await user.type(field, 'from:anna');
    await user.keyboard('{Enter}');
    const row = await screen.findByTestId('search-results-row');
    expect(row).toHaveTextContent('from:anna');
    expect(row).toHaveTextContent('7');
    expect(useSelectionStore.getState().activeMailboxId).toBe('INBOX');
  });

  it('blank input does not submit', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    render(<App />);
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    const field = screen.getByLabelText('Search mail');
    await user.click(field);
    await user.keyboard('{Enter}');
    expect(screen.queryByTestId('search-results-row')).not.toBeInTheDocument();
  });

  it('Escape with text clears search without touching mail selection; Escape when empty blurs', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    ipc.override('search_threads', { items: [searchResultThread], nextCursor: null, total: 1 });
    render(<App />);
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    const field = screen.getByLabelText('Search mail');
    await user.click(field);
    await user.type(field, 'from:anna');
    await user.keyboard('{Enter}');
    await screen.findByTestId('search-results-row');
    act(() => useSelectionStore.getState().setActiveThreadId('thread-1'));
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('search-results-row')).not.toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
    expect(useSelectionStore.getState().activeThreadId).toBe('thread-1');
    await user.keyboard('{Escape}');
    expect(field).not.toHaveFocus();
  });

  it('the sidebar row close control and selecting a real mailbox both clear search', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    ipc.override('search_threads', { items: [searchResultThread], nextCursor: null, total: 1 });
    render(<App />);
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    const field = screen.getByLabelText('Search mail');
    await user.click(field);
    await user.type(field, 'from:anna');
    await user.keyboard('{Enter}');
    await screen.findByTestId('search-results-row');
    await user.click(screen.getByRole('button', { name: 'Close search' }));
    expect(screen.queryByTestId('search-results-row')).not.toBeInTheDocument();
    expect(field).toHaveValue('');

    await user.type(field, 'from:anna');
    await user.keyboard('{Enter}');
    await screen.findByTestId('search-results-row');
    await user.click(screen.getByRole('button', { name: 'Sent' }));
    expect(screen.queryByTestId('search-results-row')).not.toBeInTheDocument();
    expect(field).toHaveValue('');
    expect(useSelectionStore.getState().activeMailboxId).toBe('SENT');
  });

  it('rejects an over-long query with a visible reason and does not navigate to search state', async () => {
    const user = userEvent.setup();
    ipc.override('list_accounts', [account]);
    render(<App />);
    await screen.findByRole('button', { name: 'Collapse sidebar' });
    const field = screen.getByLabelText('Search mail');
    await user.click(field);
    fireEvent.change(field, { target: { value: 'x'.repeat(2049) } });
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/limited to 2048 characters/)).toBeInTheDocument();
    expect(screen.queryByTestId('search-results-row')).not.toBeInTheDocument();
  });
});
