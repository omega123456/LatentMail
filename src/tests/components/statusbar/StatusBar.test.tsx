import { act, render, screen, waitFor } from '@testing-library/react';
import type React from 'react';
import userEvent from '@testing-library/user-event';
import { format, subHours, subMinutes, subSeconds } from 'date-fns';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { EventBridge } from '@/lib/query/event-bridge';
import { ipc } from '@/tests/ipc-mock';
import { useSettingsUiStore } from '@/stores/settings-ui';
import { useSyncStore } from '@/stores/sync';

const emptyQueue = { pending: 0, active: 0, failed: 0, done: 0, paused: false };

function renderStatusBar(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function setStatus(
  state: 'idle' | 'syncing' | 'error',
  queue = emptyQueue,
  lastSynced: Date | null = new Date('2026-08-11T10:00:00Z'),
) {
  act(() =>
    useSyncStore.setState({
      queue,
      syncState: state,
      lastSynced,
      error: state === 'error' ? 'Gmail is unavailable' : undefined,
      refreshing: false,
    }),
  );
}

function overrideTraversal(
  state: 'backfilling' | 'reconciling',
  isResumed = false,
  counts = { discoveredCount: 50000, persistedCount: 12400 },
) {
  ipc.override('read_traversal_status', {
    accountId: 'account-1',
    state,
    kind: state === 'backfilling' ? 'backfill' : null,
    lastAdvancedAt: Date.parse('2026-08-11T10:00:00Z'),
    isResumed,
    ...counts,
  });
}

afterEach(() => act(() => useSyncStore.setState({ queue: emptyQueue, refreshing: false })));

describe('StatusBar', () => {
  it('announces sync freshness through a polite live region, rolling over to a clock time after an hour', async () => {
    setStatus('idle', emptyQueue, null);
    const { rerender } = renderStatusBar(<StatusBar />);
    const region = await screen.findByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region).toHaveTextContent('Not yet synced');

    setStatus('idle', emptyQueue, new Date());
    expect(region).toHaveTextContent('Synced just now');

    setStatus('idle', emptyQueue, subMinutes(subSeconds(new Date(), 30), 12));
    expect(region).toHaveTextContent('Synced 12m ago');

    const earlier = subHours(new Date(), 3);
    setStatus('idle', emptyQueue, earlier);
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <StatusBar />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('status')).toHaveTextContent(`Synced at ${format(earlier, 'p')}`);
  });

  it('tints the whole bar and swaps refresh for resume while the queue is paused', async () => {
    setStatus('idle', { pending: 3, active: 0, failed: 0, done: 0, paused: true });
    renderStatusBar(<StatusBar accountId="account-1" />);
    expect(await screen.findByText('Paused · 3 queued')).toBeInTheDocument();
    expect(screen.getByTestId('status-bar')).toHaveClass('bg-warning-container');
    expect(screen.getByTestId('status-bar')).toHaveClass('dark:bg-dark-warning-container');
    expect(screen.queryByRole('button', { name: 'Refresh mail' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resume sync' })).toBeInTheDocument();
  });

  it('leaves the bar untinted in every state the user did not choose', async () => {
    setStatus('error');
    renderStatusBar(<StatusBar />);
    await screen.findByText("Couldn't sync");
    expect(screen.getByTestId('status-bar')).not.toHaveClass('bg-warning-container');
  });

  it('offers an inline retry when the last sync failed', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const failure = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const user = userEvent.setup();
    ipc.override('read_sync_status', {
      accountId: 'account-1',
      state: 'error',
      lastSyncedAt: null,
      lastError: 'Gmail is unavailable',
    });
    ipc.override('trigger_sync', {
      accountId: 'account-1',
      state: 'idle',
      lastSyncedAt: Date.parse('2026-08-11T10:00:00Z'),
      lastError: null,
    });
    renderStatusBar(<StatusBar accountId="account-1" />);
    expect(await screen.findByText("Couldn't sync")).toHaveAttribute(
      'title',
      'Gmail is unavailable',
    );
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Synced/));
    log.mockRestore();
    failure.mockRestore();
  });

  it('exposes backfill progress as a progressbar with its real counts', async () => {
    overrideTraversal('backfilling');
    renderStatusBar(<StatusBar accountId="account-1" />);
    expect(await screen.findByText('Downloading mail')).toBeInTheDocument();
    const progress = screen.getByRole('progressbar');
    expect(progress).toHaveAttribute('aria-valuenow', '12400');
    expect(progress).toHaveAttribute('aria-valuemax', '50000');
    expect(progress).toHaveAttribute('aria-valuetext', '12,400 of 50,000 messages');
    expect(progress).toHaveTextContent('12,400 / 50,000');
  });

  it('names a resumed backfill and a reconciliation differently', async () => {
    overrideTraversal('backfilling', true);
    const { unmount } = renderStatusBar(<StatusBar accountId="account-1" />);
    expect(await screen.findByText('Resuming download')).toBeInTheDocument();
    unmount();
    overrideTraversal('reconciling');
    renderStatusBar(<StatusBar accountId="account-1" />);
    expect(await screen.findByText('Verifying mail')).toBeInTheDocument();
  });

  it('reports zero discovered messages as no progress rather than dividing by zero', async () => {
    overrideTraversal('backfilling', false, { discoveredCount: 0, persistedCount: 0 });
    renderStatusBar(<StatusBar accountId="account-1" />);
    expect(await screen.findByRole('progressbar')).toHaveAttribute('aria-valuemax', '0');
    expect(screen.getByRole('progressbar')).toHaveTextContent('0 / 0');
  });

  it('hides the queue indicator until there is queued or failed work', async () => {
    setStatus('idle');
    const { rerender } = renderStatusBar(<StatusBar />);
    await screen.findByRole('status');
    expect(screen.queryByRole('button', { name: 'Open queue settings' })).not.toBeInTheDocument();

    setStatus('idle', { pending: 4, active: 0, failed: 0, done: 0, paused: false });
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <StatusBar />
      </QueryClientProvider>,
    );
    expect(screen.getByRole('button', { name: 'Open queue settings' })).toHaveTextContent(
      '4 queued',
    );

    setStatus('idle', { pending: 4, active: 0, failed: 2, done: 0, paused: false });
    expect(screen.getByRole('button', { name: 'Open queue settings' })).toHaveTextContent(
      '2 failed',
    );
  });

  it('pauses and resumes through the queue commands while keeping refresh disabled without an account', async () => {
    const user = userEvent.setup();
    setStatus('idle');
    ipc.override('pause_queue', { pending: 2, active: 0, failed: 0, done: 0, paused: true });
    ipc.override('resume_queue', { pending: 0, active: 0, failed: 0, done: 0, paused: false });
    renderStatusBar(<StatusBar />);
    await user.click(screen.getByRole('button', { name: 'Pause sync' }));
    await waitFor(() => expect(screen.getByText('Paused · 2 queued')).toBeInTheDocument());
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
    renderStatusBar(<StatusBar accountId="account-1" />);
    expect(await screen.findByRole('status')).toHaveAttribute('title', 'Aug 11, 2026, 9:30 AM');
  });

  it('enables the refresh control for an active account and triggers a real sync', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
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
    renderStatusBar(<StatusBar accountId="account-1" />);
    const refresh = await screen.findByRole('button', { name: 'Refresh mail' });
    expect(refresh).toBeEnabled();
    await user.click(refresh);
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveAttribute('title', 'Aug 11, 2026, 10:00 AM'),
    );
    log.mockRestore();
  });

  it('selects the Queue settings section when the queue indicator is activated', async () => {
    const user = userEvent.setup();
    useSettingsUiStore.setState({ activeSection: 'general' });
    setStatus('idle', { pending: 1, active: 0, failed: 0, done: 0, paused: false });
    renderStatusBar(<StatusBar />);
    await user.click(screen.getByRole('button', { name: 'Open queue settings' }));
    expect(useSettingsUiStore.getState().activeSection).toBe('queue');
  });

  it('does not announce a background tick; a manual refresh does', async () => {
    const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const user = userEvent.setup();
    let finish:
      | ((value: {
          accountId: string;
          state: 'idle';
          lastSyncedAt: number;
          lastError: null;
        }) => void)
      | undefined;
    ipc.override(
      'trigger_sync',
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderStatusBar(
      <>
        <EventBridge />
        <StatusBar accountId="account-1" />
      </>,
    );
    await waitFor(() =>
      expect(ipc.tauriListen).toHaveBeenCalledWith('sync://progress', expect.any(Function)),
    );
    act(() => ipc.emit('sync://progress', { accountId: 'account-1', state: 'syncing' }));
    expect(screen.queryByText('Checking for new mail…')).not.toBeInTheDocument();
    await user.click(await screen.findByRole('button', { name: 'Refresh mail' }));
    expect(await screen.findByText('Checking for new mail…')).toBeInTheDocument();
    act(() => {
      finish!({
        accountId: 'account-1',
        state: 'idle',
        lastSyncedAt: Date.parse('2026-08-11T10:00:00Z'),
        lastError: null,
      });
    });
    await waitFor(() =>
      expect(screen.queryByText('Checking for new mail…')).not.toBeInTheDocument(),
    );
    log.mockRestore();
  });
});
