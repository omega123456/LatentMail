import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueAccountCard } from '@/components/queue/QueueAccountCard';
import { useSettingsUiStore } from '@/stores/settings-ui';
import type { Account, AccountQueueSnapshot } from '@/lib/types/ipc';

const account: Account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

function snapshot(overrides: Partial<AccountQueueSnapshot>): AccountQueueSnapshot {
  return {
    accountId: 'account-1',
    active: 0,
    queued: 0,
    failed: 0,
    lanes: [
      { lane: 'interactive', capacity: 4, active: 0, backlog: 0, state: 'idle', operations: [] },
      { lane: 'background', capacity: 2, active: 0, backlog: 0, state: 'idle', operations: [] },
      { lane: 'traversal', capacity: 1, active: 0, backlog: 0, state: 'idle', operations: [] },
    ],
    ...overrides,
  };
}

describe('QueueAccountCard', () => {
  beforeEach(() => {
    act(() => useSettingsUiStore.setState({ expandedLanes: new Set() }));
  });

  it('renders the account identity, three lane rows and states the bar condition in text', () => {
    render(
      <QueueAccountCard
        account={account}
        snapshot={snapshot({ active: 1, queued: 2 })}
        onTogglePause={vi.fn()}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    expect(screen.getByText('Alex Morgan')).toBeInTheDocument();
    expect(screen.getByText('1 active')).toBeInTheDocument();
    expect(screen.getByText('2 queued')).toBeInTheDocument();
    expect(screen.getByText('Interactive')).toBeInTheDocument();
    expect(screen.getByText('Background')).toBeInTheDocument();
    expect(screen.getByText('Traversal')).toBeInTheDocument();
  });

  it('falls back to the account id as the label when the account is unknown', () => {
    render(
      <QueueAccountCard
        account={undefined}
        snapshot={snapshot({})}
        onTogglePause={vi.fn()}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    expect(screen.getByText('account-1')).toBeInTheDocument();
  });

  it('pauses the whole account, and offers Resume once every lane is paused', async () => {
    const user = userEvent.setup();
    const onTogglePause = vi.fn();
    render(
      <QueueAccountCard
        account={account}
        snapshot={snapshot({})}
        onTogglePause={onTogglePause}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Pause queued work for Alex Morgan' }));
    expect(onTogglePause).toHaveBeenCalledWith('account-1', undefined, true);
  });

  it('shows Resume for the account once every lane already reports paused', () => {
    render(
      <QueueAccountCard
        account={account}
        snapshot={snapshot({
          lanes: [
            {
              lane: 'interactive',
              capacity: 4,
              active: 0,
              backlog: 0,
              state: 'paused',
              operations: [],
            },
            {
              lane: 'background',
              capacity: 2,
              active: 0,
              backlog: 0,
              state: 'paused',
              operations: [],
            },
            {
              lane: 'traversal',
              capacity: 1,
              active: 0,
              backlog: 0,
              state: 'paused',
              operations: [],
            },
          ],
        })}
        onTogglePause={vi.fn()}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Resume queued work for Alex Morgan' }),
    ).toBeInTheDocument();
  });

  it('pauses a single lane at its own scope, independent of the account scope', async () => {
    const user = userEvent.setup();
    const onTogglePause = vi.fn();
    render(
      <QueueAccountCard
        account={account}
        snapshot={snapshot({})}
        onTogglePause={onTogglePause}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: 'Pause the Interactive lane for this account' }),
    );
    expect(onTogglePause).toHaveBeenCalledWith('account-1', 'interactive', true);
  });
});
