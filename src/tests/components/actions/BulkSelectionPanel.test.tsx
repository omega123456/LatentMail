import { parseISO } from 'date-fns';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BulkSelectionPanel } from '@/components/actions/BulkSelectionPanel';
import type { Conversation } from '@/lib/types/conversation';

const SELECTED_ROW_COUNT = 2;

function baseHandlers() {
  return {
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onApplyLabels: vi.fn(),
    onMoveTo: vi.fn(),
    onToggleSpam: vi.fn(),
    onDelete: vi.fn(),
    onClearSelection: vi.fn(),
    onSelectAll: vi.fn(),
  };
}

function thread(id: string, overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: id,
    sender: `Sender ${id}`,
    subject: `Subject ${id}`,
    snippet: `Snippet ${id}`,
    date: parseISO('2026-08-10T09:00:00Z'),
    unread: false,
    starred: false,
    ...overrides,
  };
}

type PanelSetup = {
  count: number;
  selectedThreads: Conversation[];
  loadedThreadCount: number;
  handlers: ReturnType<typeof baseHandlers>;
};

function renderPanel({ count, selectedThreads, loadedThreadCount, handlers }: PanelSetup) {
  render(
    <BulkSelectionPanel
      count={count}
      selectedThreads={selectedThreads}
      loadedThreadCount={loadedThreadCount}
      systemLabelIds={[]}
      unread={false}
      starred={false}
      labels={[]}
      {...handlers}
    />,
  );
}

describe('BulkSelectionPanel', () => {
  it('states the count and reuses ActionRibbon inline for bulk actions', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    renderPanel({
      count: 12,
      selectedThreads: [thread('a'), thread('b')],
      loadedThreadCount: 24,
      handlers: handlers,
    });
    expect(screen.getByText('12 conversations selected')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledOnce();
  });

  it('uses singular phrasing for a single selected conversation', () => {
    renderPanel({
      count: 1,
      selectedThreads: [thread('a')],
      loadedThreadCount: 4,
      handlers: baseHandlers(),
    });
    expect(screen.getByText('1 conversation selected')).toBeInTheDocument();
  });

  it('lists every selected thread with its sender, subject and snippet', () => {
    renderPanel({
      count: 2,
      selectedThreads: [thread('a'), thread('b')],
      loadedThreadCount: 6,
      handlers: baseHandlers(),
    });
    expect(screen.getAllByTestId('bulk-selection-row')).toHaveLength(SELECTED_ROW_COUNT);
    expect(screen.getByText('Sender a')).toBeInTheDocument();
    expect(screen.getByText('Subject b')).toBeInTheDocument();
    expect(screen.getByText('Snippet b')).toBeInTheDocument();
  });

  it('tallies unread and starred threads only when there are some', () => {
    const { unmount } = render(
      <BulkSelectionPanel
        count={3}
        selectedThreads={[
          thread('a', { unread: true }),
          thread('b', { unread: true, starred: true }),
          thread('c'),
        ]}
        loadedThreadCount={9}
        systemLabelIds={[]}
        unread
        starred
        labels={[]}
        {...baseHandlers()}
      />,
    );
    expect(screen.getByText('2 unread · 1 starred')).toBeInTheDocument();
    unmount();
    renderPanel({
      count: 1,
      selectedThreads: [thread('a')],
      loadedThreadCount: 9,
      handlers: baseHandlers(),
    });
    expect(screen.queryByText(/unread/)).not.toBeInTheDocument();
  });

  it('marks unread and starred threads in the list', () => {
    renderPanel({
      count: 2,
      selectedThreads: [thread('a', { unread: true }), thread('b', { starred: true })],
      loadedThreadCount: 6,
      handlers: baseHandlers(),
    });
    expect(screen.getByLabelText('Unread')).toBeInTheDocument();
    expect(screen.getByLabelText('Starred')).toBeInTheDocument();
  });

  it('clears the selection from a labelled control', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    renderPanel({
      count: 2,
      selectedThreads: [thread('a'), thread('b')],
      loadedThreadCount: 6,
      handlers: handlers,
    });
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(handlers.onClearSelection).toHaveBeenCalledOnce();
  });

  it('offers Select all while some loaded threads are unselected', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    renderPanel({
      count: 2,
      selectedThreads: [thread('a'), thread('b')],
      loadedThreadCount: 6,
      handlers: handlers,
    });
    await user.click(screen.getByRole('button', { name: 'Select all 6' }));
    expect(handlers.onSelectAll).toHaveBeenCalledOnce();
  });

  it('hides Select all once every loaded thread is selected', () => {
    renderPanel({
      count: 2,
      selectedThreads: [thread('a'), thread('b')],
      loadedThreadCount: 2,
      handlers: baseHandlers(),
    });
    expect(screen.queryByRole('button', { name: /Select all/ })).not.toBeInTheDocument();
  });
});
