import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationList } from '@/components/list/ConversationList';
import { ListHeader } from '@/components/list/ListHeader';
import { useLayoutStore } from '@/stores/layout';
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
});
