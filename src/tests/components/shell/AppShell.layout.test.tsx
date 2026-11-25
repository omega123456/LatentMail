import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';
import {
  accountOne,
  overrideAccount,
  resetAppShellStores,
  threadOne,
} from '@/tests/components/shell/app-shell-helpers';

const LIST_WIDTH_AFTER_DRAG = 370;
const PRESERVED_SCROLL_TOP = 413;
const READER_HEIGHT_MIN_PERCENT = 20;
const READER_HEIGHT_MAX_PERCENT = 80;

beforeEach(() => {
  resetAppShellStores();
});

describe('AppShell layout and settings', () => {
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

    const inboxButton = screen
      .getAllByText('Inbox')
      .map((element) => element.closest('button'))
      .find((button) => button !== null);
    if (!inboxButton) throw new Error('expected an Inbox button');
    await user.click(inboxButton);
    expect(useSelectionStore.getState().activeMailboxId).toBe('INBOX');

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize conversation list' }), {
      clientX: 10,
    });
    fireEvent.pointerMove(window, { clientX: 30 });
    fireEvent.pointerUp(window);
    expect(useLayoutStore.getState().listWidth).toBe(LIST_WIDTH_AFTER_DRAG);

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
    const list = screen.getByTestId('conversation-list');
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 413 });

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
    const preservedMail = screen.getByTestId('mail-layout').parentElement;
    expect(preservedMail).not.toHaveAttribute('hidden');
    expect(preservedMail).toHaveAttribute('inert');
    expect(preservedMail).toHaveClass('invisible', 'pointer-events-none');
    await user.click(screen.getByRole('button', { name: 'Back to Mail' }));
    await screen.findByTestId('mail-layout');

    expect(screen.getByTestId('conversation-list')).toBe(list);
    expect(list.scrollTop).toBe(PRESERVED_SCROLL_TOP);
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
    expect(useLayoutStore.getState().readerHeight).toBe(READER_HEIGHT_MIN_PERCENT);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize reader' }), { clientY: 30 });
    fireEvent.pointerMove(window, { clientY: 10 });
    fireEvent.pointerUp(window);
    expect(useLayoutStore.getState().readerHeight).toBe(READER_HEIGHT_MAX_PERCENT);
  });
});
