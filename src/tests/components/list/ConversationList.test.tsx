import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '@/components/list/ConversationList';
import { ListHeader } from '@/components/list/ListHeader';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import { useLayoutStore } from '@/stores/layout';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';

const nextPage = [
  {
    id: 'thread-5',
    sender: 'Page Two',
    subject: 'More mail',
    snippet: '',
    date: new Date('2026-08-01T10:00:00Z'),
    unread: false,
    starred: false,
  },
];
const prepended = [
  {
    id: 'thread-0',
    sender: 'New mail',
    subject: 'A fresh message',
    snippet: '',
    date: new Date('2026-08-11T11:00:00Z'),
    unread: true,
    starred: false,
  },
];

beforeEach(() => {
  useLayoutStore.setState({ density: 'comfortable', layout: 'three-column' });
  useSelectionStore.setState({
    activeMailboxId: 'INBOX',
    activeThreadId: null,
    keyboardCursor: null,
  });
  useMultiSelectStore.setState({ selectedIds: new Set(), anchorId: null });
});

describe('ConversationList', () => {
  it('reflows rows by density and only shows snippets when spacious', async () => {
    const user = userEvent.setup();
    render(
      <>
        <ListHeader />
        <ConversationList />
      </>,
    );
    expect(screen.getAllByTestId('conversation-row')[0]).toHaveAttribute(
      'data-density',
      'comfortable',
    );
    expect(screen.queryByText(/finalized slides/)).not.toBeInTheDocument();
    await user.click(screen.getByLabelText('Cycle conversation density'));
    expect(screen.getAllByTestId('conversation-row')[0]).toHaveAttribute(
      'data-density',
      'spacious',
    );
    expect(screen.getByText(/finalized slides/)).toBeInTheDocument();
    expect(screen.getByText('Marketing')).toBeInTheDocument();
  });

  it('opens and marks rows read with keyboard navigation, including clamps', () => {
    render(<ConversationList />);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    expect(useSelectionStore.getState()).toMatchObject({
      keyboardCursor: 0,
      activeThreadId: 'thread-1',
    });
    expect(screen.getAllByLabelText('Read')[0]).toBeInTheDocument();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' })));
    expect(useSelectionStore.getState().keyboardCursor).toBe(0);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(useSelectionStore.getState().activeThreadId).toBeNull();
  });

  it('renders state-specific copy and retry', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { rerender } = render(<ConversationList state="loading" />);
    expect(screen.getByText('Loading conversations…')).toBeInTheDocument();
    rerender(<ConversationList state="empty" />);
    expect(screen.getByText('Your Inbox is clear.')).toBeInTheDocument();
    rerender(<ConversationList state="error" onRetry={retry} />);
    await user.click(screen.getByText('Retry'));
    expect(retry).toHaveBeenCalledOnce();

    // The reason Rust gave is shown inline — a bare "Couldn't load" is not
    // something a user (or a developer) can act on.
    rerender(<ConversationList state="error" errorMessage="no such column: snippet" />);
    expect(screen.getByText('no such column: snippet')).toBeInTheDocument();
  });

  it('renders the still-syncing empty state with a spinner and n/total progress counts', () => {
    render(
      <ConversationList
        state="syncing"
        syncProgress={{ persistedCount: 12400, discoveredCount: 50000 }}
      />,
    );
    expect(screen.getByTestId('empty-state-syncing')).toBeInTheDocument();
    expect(screen.getByText('Older mail is still arriving')).toBeInTheDocument();
    expect(screen.getByText('12,400 of 50,000 so far')).toBeInTheDocument();
  });

  it('loads the next fixture page at the bottom and preserves the scroll anchor across prepends', () => {
    const { rerender } = render(
      <ConversationList
        pages={[
          [
            {
              id: 'thread-a',
              sender: 'A',
              subject: 'First',
              snippet: '',
              date: new Date(),
              unread: false,
              starred: false,
            },
          ],
          nextPage,
        ]}
      />,
    );
    const list = screen.getByTestId('conversation-list');
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
    });
    act(() => list.dispatchEvent(new Event('scroll')));
    expect(screen.getByText('More mail')).toBeInTheDocument();
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 30 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 200 });
    rerender(<ConversationList threads={[...prepended, ...nextPage]} />);
    expect(list.scrollTop).toBeGreaterThan(30);
  });

  it('shows a label already on the row as checked in the row context menu and lets it be removed', async () => {
    const user = userEvent.setup();
    const onTriage = vi.fn();
    const allLabels: LabelMenuEntry[] = [
      { id: 'Label_1', name: 'Marketing', color: 'blue', membership: 'unchecked' },
    ];
    render(<ConversationList allLabels={allLabels} onTriage={onTriage} />);
    const row = screen.getAllByTestId('conversation-row')[0];
    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.hover(await screen.findByText('Labels'));
    const entry = await screen.findByRole('menuitemcheckbox', { name: /Marketing/ });
    expect(entry).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(entry);
    expect(onTriage).toHaveBeenCalledWith(['thread-1'], { add: [], remove: ['Label_1'] });
  });
});

describe('ConversationList multi-selection', () => {
  it('Cmd/Ctrl-click toggles a row into and out of the selection without opening it', () => {
    render(<ConversationList />);
    const rows = screen.getAllByTestId('conversation-row');

    fireEvent.click(screen.getByLabelText('Open Updates to Color Tokens'), { ctrlKey: true });
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
    expect(useSelectionStore.getState().activeThreadId).toBeNull();

    fireEvent.click(screen.getByLabelText('Open Updates to Color Tokens'), { metaKey: true });
    expect(rows[1]).not.toHaveAttribute('data-selected');
  });

  it('includes the focused row when the first Cmd/Ctrl-click starts a multi-selection', () => {
    render(<ConversationList />);
    const rows = screen.getAllByTestId('conversation-row');

    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'));
    fireEvent.click(screen.getByLabelText('Open Updates to Color Tokens'), { ctrlKey: true });

    expect(rows[0]).toHaveAttribute('data-selected', 'true');
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
  });

  it('Shift-click selects a contiguous range from the focused row', () => {
    render(<ConversationList />);
    const rows = screen.getAllByTestId('conversation-row');

    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'));
    fireEvent.click(screen.getByLabelText('Open Action Required: 2FA Setup'), { shiftKey: true });

    expect(rows[0]).toHaveAttribute('data-selected', 'true');
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
    expect(rows[2]).toHaveAttribute('data-selected', 'true');
    expect(rows[3]).not.toHaveAttribute('data-selected');
  });

  it('Cmd/Ctrl-A selects exactly the loaded rows', () => {
    render(<ConversationList />);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })));
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(4);
    for (const row of screen.getAllByTestId('conversation-row'))
      expect(row).toHaveAttribute('data-selected', 'true');
  });

  it('a plain click clears the multi-selection and opens the row', async () => {
    const user = userEvent.setup();
    render(<ConversationList />);
    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'), {
      ctrlKey: true,
    });
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(1);

    await user.click(screen.getByLabelText('Open Updates to Color Tokens'));

    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
    expect(useSelectionStore.getState().activeThreadId).toBe('thread-2');
  });

  it('Escape clears an active multi-selection before it ever touches the open conversation', () => {
    render(<ConversationList />);
    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'), {
      ctrlKey: true,
    });

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
  });

  it('no single-active-row highlight renders while more than one row is selected', () => {
    render(<ConversationList />);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' })));
    expect(useSelectionStore.getState().keyboardCursor).toBe(0);

    fireEvent.click(screen.getByLabelText('Open Updates to Color Tokens'), { ctrlKey: true });
    fireEvent.click(screen.getByLabelText('Open Action Required: 2FA Setup'), { ctrlKey: true });

    for (const row of screen.getAllByTestId('conversation-row'))
      expect(row).not.toHaveAttribute('data-active');
  });
});

describe('ConversationList triage shortcuts', () => {
  it('uses the registry bindings for selected conversations and ignores focused inputs', () => {
    const onTriage = vi.fn();
    render(<><input aria-label="filter" /><ConversationList onTriage={onTriage} /></>);
    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'), { ctrlKey: true });
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', shiftKey: true })));
    expect(onTriage).toHaveBeenLastCalledWith(['thread-1'], { add: [], remove: ['UNREAD'] });
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'J', ctrlKey: true, shiftKey: true })));
    expect(onTriage).toHaveBeenLastCalledWith(['thread-1'], { add: [], remove: ['SPAM'] });
    screen.getByLabelText('filter').focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })));
    expect(onTriage).toHaveBeenCalledTimes(2);
  });
});
