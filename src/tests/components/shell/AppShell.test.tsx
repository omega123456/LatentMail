import { act, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import App from '@/App';
import { AppShell } from '@/components/shell/AppShell';
import { queryKeys } from '@/lib/query/keys';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import { useMessageSourceStore } from '@/stores/message-source';
import { useSelectionStore } from '@/stores/selection';
import {
  accountOne,
  accountTwo,
  conversationOne,
  inboxLabel,
  overrideAccount,
  resetAppShellStores,
  threadOne,
  workLabel,
} from '@/tests/components/shell/app-shell-helpers';

beforeEach(() => {
  resetAppShellStores();
});

it('paints the startup surface while accounts are pending', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <AppShell />
    </QueryClientProvider>,
  );
  expect(screen.getByTestId('startup-surface')).toBeInTheDocument();
});

it('paints the startup surface during the configured-route correction', () => {
  const client = new QueryClient();
  client.setQueryData(queryKeys.accounts, [accountOne]);
  const setRoute = useLayoutStore.getState().setRoute;
  act(() => useLayoutStore.setState({ route: 'auth', setRoute: vi.fn() }));
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <AppShell />
    </QueryClientProvider>,
  );
  expect(screen.getByTestId('startup-surface')).toBeInTheDocument();
  unmount();
  act(() => useLayoutStore.setState({ setRoute }));
});

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

it('opens the original source of the newest message from the keyboard', async () => {
  useMessageSourceStore.setState({ target: null });
  ipc.override('list_accounts', [accountOne]);
  overrideAccount('account-1', [threadOne]);
  ipc.override('load_conversation', conversationOne);
  ipc.override('read_message_source', {
    messageId: '<q3@example.com>',
    sentAt: conversationOne.messages[0].sentAt,
    sender: conversationOne.messages[0].sender,
    to: 'You <you@example.com>',
    cc: '',
    subject: 'Q3 review',
    authenticationResults: null,
    sizeBytes: 64,
    raw: 'Subject: Q3 review\r\n\r\nAttached slides',
    display: 'Subject: Q3 review\n\nAttached slides',
  });

  render(<App />);
  expect(await screen.findByText('Q3 review')).toBeInTheDocument();
  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
  await screen.findByTestId('message-message-1');
  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', ctrlKey: true })));

  expect(await screen.findByText('Original message · Q3 review')).toBeInTheDocument();
  expect(useMessageSourceStore.getState().target).toEqual({
    accountId: 'account-1',
    messageId: 'message-1',
  });
  act(() => useMessageSourceStore.setState({ target: null }));
});

it('ignores the source shortcut when the newest message is a draft', async () => {
  useMessageSourceStore.setState({ target: null });
  ipc.override('list_accounts', [accountOne]);
  overrideAccount('account-1', [threadOne]);
  ipc.override('load_conversation', {
    ...conversationOne,
    messages: [{ ...conversationOne.messages[0], labelIds: ['DRAFT'] }],
  });

  render(<App />);
  expect(await screen.findByText('Q3 review')).toBeInTheDocument();
  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
  await screen.findByTestId('message-message-1');
  await act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', ctrlKey: true })));

  expect(useMessageSourceStore.getState().target).toBeNull();
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
