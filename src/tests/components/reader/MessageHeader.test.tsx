import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { parseISO } from 'date-fns';
import { MessageHeader } from '@/components/reader/MessageHeader';
import { useLayoutStore } from '@/stores/layout';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

describe('MessageHeader', () => {
  it('opens a pre-addressed compose for the sender and first recipient', async () => {
    const user = userEvent.setup();
    const compose = vi.fn();
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[
          { name: 'Me', address: 'me@example.com' },
          { name: 'Team', address: 'team@example.com' },
        ]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
        onComposeTo={compose}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Elena' }));
    await user.click(screen.getByRole('button', { name: /to Me/ }));
    expect(compose).toHaveBeenNthCalledWith(1, { name: 'Elena', address: 'elena@example.com' });
    expect(compose).toHaveBeenNthCalledWith(2, { name: 'Me', address: 'me@example.com' });
  });

  it('lists the message badges beside the sender', () => {
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
        badges={[
          { kind: 'system', id: 'INBOX' },
          { kind: 'user', id: 'Label_1', name: 'Invoices', color: 'blue' },
        ]}
      />,
    );

    const badges = screen.getByRole('list', { name: 'Labels' });
    expect(badges).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      'Inbox',
      'Invoices',
    ]);
  });

  it('renders through the shared Avatar component with a visible initial when the sender has no display name', () => {
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: '', address: 'noname@example.com' }}
        recipients={[]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
      />,
    );

    expect(screen.getByText('N')).toBeInTheDocument();
  });

  it('retains the ring around the initial-only avatar (plan: "the existing 48px circle and its ring are retained")', () => {
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
      />,
    );

    const plate = screen.getByText('E');
    expect(plate).toHaveClass('ring-2');
    expect(plate).toHaveClass('ring-surface-container');
    expect(plate).toHaveClass('dark:ring-dark-surface-container');
  });

  it('renders no avatar at all when the preference is off', () => {
    act(() => useLayoutStore.setState({ showSenderAvatars: false }));
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
      />,
    );
    expect(screen.queryByText('E')).not.toBeInTheDocument();
    act(() => useLayoutStore.setState({ showSenderAvatars: true }));
  });

  it('opens the same sender compose from the display name and from the address', async () => {
    const user = userEvent.setup();
    const compose = vi.fn();
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[{ name: 'Me', address: 'me@example.com' }]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
        onComposeTo={compose}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Elena' }));
    await user.click(screen.getByRole('button', { name: '<elena@example.com>' }));
    expect(compose).toHaveBeenNthCalledWith(1, { name: 'Elena', address: 'elena@example.com' });
    expect(compose).toHaveBeenNthCalledWith(2, { name: 'Elena', address: 'elena@example.com' });
  });

  it('copies the sender address and announces it, then returns to the copy icon', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy elena@example.com' }));
    expect(writeText).toHaveBeenCalledWith('elena@example.com');
    expect(await screen.findByRole('status')).toHaveTextContent('Copied elena@example.com');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(screen.getByRole('status')).toHaveTextContent('');
    vi.useRealTimers();
  });

  it('copies every recipient address from the single control on the to line', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[
          { name: 'Me', address: 'me@example.com' },
          { name: 'Team', address: 'team@example.com' },
        ]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Copy all recipient addresses' }));
    expect(writeText).toHaveBeenCalledWith('me@example.com, team@example.com');
  });

  it('offers no recipient copy control when the message lists no recipients', () => {
    renderWithQueryClient(
      <MessageHeader
        sender={{ name: 'Elena', address: 'elena@example.com' }}
        recipients={[]}
        sentAt={parseISO('2026-08-13T12:00:00Z')}
      />,
    );
    expect(screen.getByRole('button', { name: 'Copy elena@example.com' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Copy all recipient addresses' }),
    ).not.toBeInTheDocument();
  });
});
