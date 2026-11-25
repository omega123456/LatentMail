import { parseISO } from 'date-fns';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '@/components/list/ConversationList';
import { ListHeader } from '@/components/list/ListHeader';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';
import { useSelectionStore } from '@/stores/selection';
import { useSearchStore } from '@/stores/search';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { resetConversationListStores } from '@/tests/components/list/conversation-list-helpers';

const CURSOR_AFTER_FIRST_PAGE_DOWN = 2;
const CURSOR_AFTER_SECOND_PAGE_DOWN = 3;
const PRESERVED_SCROLL_TOP = 30;

const nextPage = [
  {
    id: 'thread-5',
    sender: 'Page Two',
    subject: 'More mail',
    snippet: '',
    date: parseISO('2026-08-01T10:00:00Z'),
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
    date: parseISO('2026-08-11T11:00:00Z'),
    unread: true,
    starred: false,
  },
];

beforeEach(() => {
  resetConversationListStores();
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
    expect(useSelectionStore.getState().keyboardCursor).toBe(CURSOR_AFTER_FIRST_PAGE_DOWN);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' })));
    expect(useSelectionStore.getState().keyboardCursor).toBe(CURSOR_AFTER_SECOND_PAGE_DOWN);
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
    expect(useSelectionStore.getState().keyboardCursor).toBe(0);
    expect(screen.getAllByTestId('conversation-row')[0]).toHaveAttribute('data-active', 'true');
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
    expect(list.scrollTop).toBeGreaterThan(PRESERVED_SCROLL_TOP);
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
    expect(list.scrollTop).toBeGreaterThan(PRESERVED_SCROLL_TOP);
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
