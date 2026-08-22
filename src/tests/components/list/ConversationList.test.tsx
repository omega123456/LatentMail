import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '@/components/list/ConversationList';
import { ListHeader } from '@/components/list/ListHeader';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import { useLayoutStore } from '@/stores/layout';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

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
    flashThreadId: null,
  });
  useMultiSelectStore.setState({ selectedIds: new Set(), anchorId: null });
});

describe('ConversationList', () => {
  it('reflows rows by density and only shows snippets when spacious', async () => {
    const user = userEvent.setup();
    const marketing: LabelMenuEntry[] = [
      { id: 'Label_1', name: 'Marketing', color: 'blue', membership: 'unchecked' },
    ];
    renderWithQueryClient(
      <>
        <ListHeader />
        <ConversationList allLabels={marketing} />
      </>,
    );
    expect(screen.getAllByTestId('conversation-row')[0]).toHaveAttribute(
      'data-density',
      'comfortable',
    );
    expect(screen.queryByText(/finalized slides/)).not.toBeInTheDocument();
    const densityButton = screen.getByLabelText('Cycle conversation density');
    expect(densityButton.querySelector('svg')).toHaveClass('lucide-rows-3');
    await user.click(densityButton);
    expect(densityButton.querySelector('svg')).toHaveClass('lucide-rows-2');
    expect(screen.getAllByTestId('conversation-row')[0]).toHaveAttribute(
      'data-density',
      'spacious',
    );
    expect(screen.getByText(/finalized slides/)).toBeInTheDocument();
    expect(screen.getByTitle('Marketing')).toHaveTextContent('Marketing');
  });

  it('opens and marks rows read with keyboard navigation, including clamps', () => {
    renderWithQueryClient(<ConversationList />);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' })));
    expect(useSelectionStore.getState()).toMatchObject({
      keyboardCursor: 0,
      activeThreadId: 'thread-1',
    });
    expect(screen.getAllByText('Read')[0]).toBeInTheDocument();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' })));
    expect(useSelectionStore.getState().keyboardCursor).toBe(0);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(useSelectionStore.getState().activeThreadId).toBeNull();
  });

  it('moves the cursor a screen at a time with PageDown and PageUp, clamped to the loaded rows', () => {
    renderWithQueryClient(<ConversationList />);
    Object.defineProperty(screen.getByTestId('conversation-list'), 'clientHeight', {
      configurable: true,
      value: 272,
    });
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' })));
    expect(useSelectionStore.getState().keyboardCursor).toBe(2);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' })));
    expect(useSelectionStore.getState().keyboardCursor).toBe(3);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' })));
    expect(useSelectionStore.getState().keyboardCursor).toBe(0);
  });

  it('scrolls back to the top when the mailbox changes instead of keeping the previous offset', () => {
    renderWithQueryClient(<ConversationList />);
    const list = screen.getByTestId('conversation-list');
    const scrollTo = vi.fn();
    Object.defineProperty(list, 'scrollTo', { configurable: true, value: scrollTo });
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 400 });
    act(() => useSelectionStore.getState().setActiveMailboxId('SENT'));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 0 }));
  });

  it('renders state-specific copy and retry', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    const { rerender } = renderWithQueryClient(<ConversationList state="loading" />);
    expect(screen.getByText('Loading conversations…')).toBeInTheDocument();
    rerender(<ConversationList state="empty" />);
    expect(screen.getByText('Your Inbox is clear.')).toBeInTheDocument();
    rerender(<ConversationList state="error" onRetry={retry} />);
    await user.click(screen.getByText('Retry'));
    expect(retry).toHaveBeenCalledOnce();

    rerender(<ConversationList state="error" errorMessage="no such column: snippet" />);
    expect(screen.getByText('no such column: snippet')).toBeInTheDocument();
  });

  it('clears a notification flash without animating when reduced motion is requested', async () => {
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
    useSelectionStore.getState().setFlashThreadId('thread-1');
    renderWithQueryClient(<ConversationList />);
    expect(screen.getAllByTestId('conversation-row')).not.toHaveLength(0);
    expect(useSelectionStore.getState().flashThreadId).toBeNull();
    expect(screen.getAllByTestId('conversation-row')[0]).not.toHaveClass(
      'motion-safe:animate-row-flash',
    );
    vi.mocked(window.matchMedia).mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as MediaQueryList);
  });

  it('renders the still-syncing empty state with a spinner and n/total progress counts', () => {
    renderWithQueryClient(
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
    const { rerender } = renderWithQueryClient(
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

  it('requests an older page at the retained window top and preserves its scroll anchor', () => {
    const onLoadPrevious = vi.fn();
    const { rerender } = renderWithQueryClient(
      <ConversationList threads={nextPage} onLoadPrevious={onLoadPrevious} />,
    );
    const list = screen.getByTestId('conversation-list');
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 100 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });
    act(() => list.dispatchEvent(new Event('scroll')));
    expect(onLoadPrevious).toHaveBeenCalledOnce();
    rerender(<ConversationList threads={[...nextPage]} onLoadPrevious={onLoadPrevious} />);
    Object.defineProperty(list, 'scrollTop', { configurable: true, writable: true, value: 30 });
    Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 200 });
    rerender(
      <ConversationList threads={[...prepended, ...nextPage]} onLoadPrevious={onLoadPrevious} />,
    );
    expect(list.scrollTop).toBeGreaterThan(30);
  });

  it('shows a label already on the row as checked in the row context menu and lets it be removed', async () => {
    const user = userEvent.setup();
    const onTriage = vi.fn();
    const allLabels: LabelMenuEntry[] = [
      { id: 'Label_1', name: 'Marketing', color: 'blue', membership: 'unchecked' },
    ];
    renderWithQueryClient(<ConversationList allLabels={allLabels} onTriage={onTriage} />);
    const row = screen.getAllByTestId('conversation-row')[0];
    await user.pointer({ keys: '[MouseRight]', target: row });
    await user.hover(await screen.findByText('Labels'));
    const entry = await screen.findByRole('menuitemcheckbox', { name: /Marketing/ });
    expect(entry).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(entry);
    expect(onTriage).toHaveBeenCalledWith(['thread-1'], {
      kind: 'label',
      add: [],
      remove: ['Label_1'],
    });
  });
});

describe('ConversationList multi-selection', () => {
  it('Cmd/Ctrl-click toggles a row into and out of the selection without opening it', () => {
    renderWithQueryClient(<ConversationList />);
    const rows = screen.getAllByTestId('conversation-row');

    fireEvent.click(screen.getByLabelText('Open Updates to Color Tokens'), { ctrlKey: true });
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
    expect(useSelectionStore.getState().activeThreadId).toBeNull();

    fireEvent.click(screen.getByLabelText('Open Updates to Color Tokens'), { metaKey: true });
    expect(rows[1]).not.toHaveAttribute('data-selected');
  });

  it('includes the focused row when the first Cmd/Ctrl-click starts a multi-selection', () => {
    renderWithQueryClient(<ConversationList />);
    const rows = screen.getAllByTestId('conversation-row');

    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'));
    fireEvent.click(screen.getByLabelText('Open Updates to Color Tokens'), { ctrlKey: true });

    expect(rows[0]).toHaveAttribute('data-selected', 'true');
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
  });

  it('Shift-click selects a contiguous range from the focused row', () => {
    renderWithQueryClient(<ConversationList />);
    const rows = screen.getAllByTestId('conversation-row');

    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'));
    fireEvent.click(screen.getByLabelText('Open Action Required: 2FA Setup'), { shiftKey: true });

    expect(rows[0]).toHaveAttribute('data-selected', 'true');
    expect(rows[1]).toHaveAttribute('data-selected', 'true');
    expect(rows[2]).toHaveAttribute('data-selected', 'true');
    expect(rows[3]).not.toHaveAttribute('data-selected');
  });

  it('Cmd/Ctrl-A selects exactly the loaded rows', () => {
    renderWithQueryClient(<ConversationList />);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true })));
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(4);
    for (const row of screen.getAllByTestId('conversation-row'))
      expect(row).toHaveAttribute('data-selected', 'true');
  });

  it('a plain click clears the multi-selection and opens the row', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<ConversationList />);
    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'), {
      ctrlKey: true,
    });
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(1);

    await user.click(screen.getByLabelText('Open Updates to Color Tokens'));

    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
    expect(useSelectionStore.getState().activeThreadId).toBe('thread-2');
  });

  it('Escape clears an active multi-selection before it ever touches the open conversation', () => {
    renderWithQueryClient(<ConversationList />);
    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'), {
      ctrlKey: true,
    });

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(useMultiSelectStore.getState().selectedIds.size).toBe(0);
  });

  it('derives the right-click context menu from every selected thread, not just the row that was clicked', async () => {
    const user = userEvent.setup();
    const threads = [
      {
        id: 'thread-trash',
        sender: 'Anna',
        subject: 'In trash',
        snippet: '',
        date: new Date('2026-08-11T10:00:00Z'),
        unread: false,
        starred: false,
        systemLabelIds: ['TRASH'],
      },
      {
        id: 'thread-inbox',
        sender: 'Bob',
        subject: 'In inbox',
        snippet: '',
        date: new Date('2026-08-10T10:00:00Z'),
        unread: false,
        starred: false,
        systemLabelIds: ['INBOX'],
      },
    ];
    renderWithQueryClient(<ConversationList threads={threads} />);
    fireEvent.click(screen.getByLabelText('Open In trash'), { ctrlKey: true });
    fireEvent.click(screen.getByLabelText('Open In inbox'), { ctrlKey: true });

    await user.pointer({
      keys: '[MouseRight]',
      target: screen.getByLabelText('Open In trash').closest('[data-testid="conversation-row"]')!,
    });
    expect(await screen.findByText('Delete 2')).toBeInTheDocument();
    expect(screen.getByText('Star 2')).toBeInTheDocument();
  });

  it('no single-active-row highlight renders while more than one row is selected', () => {
    renderWithQueryClient(<ConversationList />);
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
    renderWithQueryClient(
      <>
        <input aria-label="filter" />
        <ConversationList onTriage={onTriage} />
      </>,
    );
    fireEvent.click(screen.getByLabelText('Open Q3 Marketing Strategy Review'), { ctrlKey: true });
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'I', shiftKey: true })));
    expect(onTriage).toHaveBeenLastCalledWith(['thread-1'], {
      kind: 'label',
      add: [],
      remove: ['UNREAD'],
    });
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'J', ctrlKey: true, shiftKey: true }),
      ),
    );
    expect(onTriage).toHaveBeenLastCalledWith(['thread-1'], {
      kind: 'move',
      destination: 'INBOX',
    });
    screen.getByLabelText('filter').focus();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' })));
    expect(onTriage).toHaveBeenCalledTimes(2);
  });
});

describe('ConversationList — search states', () => {
  afterEach(() =>
    act(() =>
      useSearchStore.setState({
        draft: '',
        submittedQuery: '',
        scope: { kind: 'default' },
        active: false,
        panelOpen: false,
      }),
    ),
  );

  it('renders the search-specific empty state naming the query', () => {
    act(() => useSearchStore.setState({ active: true }));
    renderWithQueryClient(
      <ConversationList threads={[]} state="searchEmpty" searchQueryText="from:anna" />,
    );
    expect(screen.getByTestId('empty-state-search')).toHaveTextContent('from:anna');
  });

  it('shows the incomplete-backfill notice above rows while search is active and backfill is running, at any result count', () => {
    act(() => useSearchStore.setState({ active: true }));
    renderWithQueryClient(<ConversationList searchIncomplete />);
    expect(screen.getByTestId('search-incomplete-notice')).toBeInTheDocument();
  });

  it('shows the incomplete notice alongside zero results too', () => {
    act(() => useSearchStore.setState({ active: true }));
    renderWithQueryClient(
      <ConversationList threads={[]} state="searchEmpty" searchQueryText="none" searchIncomplete />,
    );
    expect(screen.getByTestId('search-incomplete-notice')).toBeInTheDocument();
    expect(screen.getByTestId('empty-state-search')).toBeInTheDocument();
  });

  it('omits the incomplete notice when search is not active even if backfill is running', () => {
    renderWithQueryClient(<ConversationList searchIncomplete />);
    expect(screen.queryByTestId('search-incomplete-notice')).not.toBeInTheDocument();
  });
});
