import { act, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { ipc } from '@/tests/ipc-mock';
import { useSyncStore } from '@/stores/sync';

function renderStatusBar(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

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
    const { rerender } = renderStatusBar(<StatusBar accountCount={2} />);
    expect(await screen.findByText(/Synced/)).toHaveAttribute('title', 'Aug 11, 2026, 10:00 AM');
    setStatus('syncing');
    expect(screen.getByText('Syncing…')).toBeInTheDocument();
    setStatus('error');
    expect(screen.getByText('Sync failed')).toHaveAttribute('title', 'Gmail is unavailable');
    setStatus('idle', { pending: 3, active: 0, failed: 0, done: 0, paused: true });
    expect(screen.getByText('Paused — 3 queued')).toBeInTheDocument();
    rerender(<QueryClientProvider client={new QueryClient()}><StatusBar accountCount={1} /></QueryClientProvider>);
    expect(screen.getByText('1 account')).toBeInTheDocument();
  });

  it('pauses and resumes through the queue commands while keeping refresh disabled without an account', async () => {
    const user = userEvent.setup();
    setStatus('idle');
    ipc.override('pause_queue', { pending: 2, active: 0, failed: 0, done: 0, paused: true });
    ipc.override('resume_queue', { pending: 0, active: 0, failed: 0, done: 0, paused: false });
    renderStatusBar(<StatusBar accountCount={1} />);
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
    renderStatusBar(<StatusBar accountCount={1} accountId="account-1" />);
    expect(await screen.findByText(/Synced/)).toHaveAttribute('title', 'Aug 11, 2026, 9:30 AM');
  });

  it('renders "Backfilling" with n / total counts for a fresh (non-resumed) traversal', async () => {
    ipc.override('read_traversal_status', {
      accountId: 'account-1',
      state: 'backfilling',
      kind: 'backfill',
      discoveredCount: 50000,
      persistedCount: 12400,
      lastAdvancedAt: Date.parse('2026-08-11T10:00:00Z'),
      isResumed: false,
    });
    renderStatusBar(<StatusBar accountCount={1} accountId="account-1" />);
    expect(await screen.findByText('Backfilling · 12,400 / 50,000')).toBeInTheDocument();
  });

  it('renders "Resuming backfill" with n / total counts once the traversal resumes a saved checkpoint', async () => {
    ipc.override('read_traversal_status', {
      accountId: 'account-1',
      state: 'backfilling',
      kind: 'backfill',
      discoveredCount: 50000,
      persistedCount: 12400,
      lastAdvancedAt: Date.parse('2026-08-11T10:00:00Z'),
      isResumed: true,
    });
    renderStatusBar(<StatusBar accountCount={1} accountId="account-1" />);
    expect(await screen.findByText('Resuming backfill · 12,400 / 50,000')).toBeInTheDocument();
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
    renderStatusBar(<StatusBar accountCount={1} accountId="account-1" />);
    const refresh = await screen.findByRole('button', { name: 'Refresh mail' });
    expect(refresh).toBeEnabled();
    await user.click(refresh);
    await waitFor(() =>
      expect(screen.getByText(/Synced/)).toHaveAttribute('title', 'Aug 11, 2026, 10:00 AM'),
    );
  });
});
