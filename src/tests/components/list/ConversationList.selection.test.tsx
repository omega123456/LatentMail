import { parseISO } from 'date-fns';
import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { ConversationList } from '@/components/list/ConversationList';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSelectionStore } from '@/stores/selection';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { closestOrThrow } from '@/tests/dom';
import { resetConversationListStores } from '@/tests/components/list/conversation-list-helpers';

const LOADED_ROW_COUNT = 4;

beforeEach(() => {
  resetConversationListStores();
});

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
  expect(useMultiSelectStore.getState().selectedIds.size).toBe(LOADED_ROW_COUNT);
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
      date: parseISO('2026-08-11T10:00:00Z'),
      unread: false,
      starred: false,
      systemLabelIds: ['TRASH'],
    },
    {
      id: 'thread-inbox',
      sender: 'Bob',
      subject: 'In inbox',
      snippet: '',
      date: parseISO('2026-08-10T10:00:00Z'),
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
    target: closestOrThrow(
      screen.getByLabelText('Open In trash'),
      '[data-testid="conversation-row"]',
    ),
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
