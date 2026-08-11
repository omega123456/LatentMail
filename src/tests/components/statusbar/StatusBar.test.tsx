import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { ipc } from '@/tests/ipc-mock';
import { useSyncStore } from '@/stores/sync';

function setStatus(
  state: 'idle' | 'syncing' | 'error',
  queue = { pending: 0, active: 0, failed: 0, done: 0, paused: false },
) {
  act(() =>
    useSyncStore.setState({
      queue,
      syncState: state,
      lastSynced: new Date('2026-08-11T10:00:00Z'),
      error: state === 'error' ? 'Gmail is unavailable' : undefined,
    }),
  );
}

describe('StatusBar', () => {
  it('renders each sync state, including paused queued work', async () => {
    setStatus('idle');
    const { rerender } = render(<StatusBar accountCount={2} />);
    expect(await screen.findByText(/Synced/)).toHaveAttribute('title', 'Aug 11, 2026, 10:00 AM');
    setStatus('syncing');
    expect(screen.getByText('Syncing…')).toBeInTheDocument();
    setStatus('error');
    expect(screen.getByText('Sync failed')).toHaveAttribute('title', 'Gmail is unavailable');
    setStatus('idle', { pending: 3, active: 0, failed: 0, done: 0, paused: true });
    expect(screen.getByText('Paused — 3 queued')).toBeInTheDocument();
    rerender(<StatusBar accountCount={1} />);
    expect(screen.getByText('1 account')).toBeInTheDocument();
  });

  it('pauses and resumes through the queue commands while keeping refresh disabled without an account', async () => {
    const user = userEvent.setup();
    setStatus('idle');
    ipc.override('pause_queue', { pending: 2, active: 0, failed: 0, done: 0, paused: true });
    ipc.override('resume_queue', { pending: 0, active: 0, failed: 0, done: 0, paused: false });
    render(<StatusBar accountCount={1} />);
    await user.click(screen.getByRole('button', { name: 'Pause sync' }));
    await waitFor(() => expect(screen.getByText('Paused — 2 queued')).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: 'Resume sync' }));
    await waitFor(() => expect(screen.queryByText(/Paused/)).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Refresh mail' })).toBeDisabled();
  });

  it('seeds last-synced from read_sync_status at mount, before any sync completes', async () => {
    ipc.override('read_sync_status', {
      accountId: 'account-1',
      state: 'idle',
      lastSyncedAt: Date.parse('2026-08-11T09:30:00Z'),
      lastError: null,
    });
    render(<StatusBar accountCount={1} accountId="account-1" />);
    expect(await screen.findByText(/Synced/)).toHaveAttribute('title', 'Aug 11, 2026, 9:30 AM');
  });

  it('enables the refresh control for an active account and triggers a real sync', async () => {
    const user = userEvent.setup();
    ipc.override('read_sync_status', {
      accountId: 'account-1',
      state: 'idle',
      lastSyncedAt: Date.parse('2026-08-11T09:30:00Z'),
      lastError: null,
    });
    ipc.override('trigger_sync', {
      accountId: 'account-1',
      state: 'idle',
      lastSyncedAt: Date.parse('2026-08-11T10:00:00Z'),
      lastError: null,
    });
    render(<StatusBar accountCount={1} accountId="account-1" />);
    const refresh = await screen.findByRole('button', { name: 'Refresh mail' });
    expect(refresh).toBeEnabled();
    await user.click(refresh);
    await waitFor(() =>
      expect(screen.getByText(/Synced/)).toHaveAttribute('title', 'Aug 11, 2026, 10:00 AM'),
    );
  });
});
