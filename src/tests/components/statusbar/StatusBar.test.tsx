import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format, getTime, parseISO, subHours, subMinutes, subSeconds } from 'date-fns';
import { afterEach, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { EventBridge } from '@/lib/query/event-bridge';
import { ipc } from '@/tests/ipc-mock';
import {
  emptyQueue,
  overrideTraversal,
  renderStatusBar,
  resetStatusBarSyncStore,
  setStatus,
} from '@/tests/components/statusbar/status-bar-helpers';

const EXTRA_SECONDS = 30;
const MINUTES_AGO = 12;
const HOURS_AGO = 3;

afterEach(() => resetStatusBarSyncStore());

it('announces sync freshness through a polite live region, rolling over to a clock time after an hour', async () => {
  setStatus('idle', emptyQueue, null);
  const { rerender } = renderStatusBar(<StatusBar />);
  const region = await screen.findByRole('status');
  expect(region).toHaveAttribute('aria-live', 'polite');
  expect(region).toHaveTextContent('Not yet synced');

  setStatus('idle', emptyQueue, new Date());
  expect(region).toHaveTextContent('Synced just now');

  setStatus('idle', emptyQueue, subMinutes(subSeconds(new Date(), EXTRA_SECONDS), MINUTES_AGO));
  expect(region).toHaveTextContent('Synced 12m ago');

  const earlier = subHours(new Date(), HOURS_AGO);
  setStatus('idle', emptyQueue, earlier);
  rerender(
    <QueryClientProvider client={new QueryClient()}>
      <StatusBar />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('status')).toHaveTextContent(`Synced at ${format(earlier, 'p')}`);
});

it('tints the whole bar and swaps refresh for resume while the queue is paused', async () => {
  setStatus('idle', {
    pending: 3,
    active: 0,
    failed: 0,
    done: 0,
    paused: true,
    suspended: false,
  });
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

it('shows a quiet reconnect state while the system is suspended', async () => {
  overrideTraversal('backfilling');
  setStatus('error', { ...emptyQueue, suspended: true });
  renderStatusBar(<StatusBar accountId="account-1" />);

  const label = await screen.findByRole('status');
  expect(label).toHaveTextContent('Sync resumes shortly');
  expect(label).not.toHaveClass('text-error');
  expect(label).not.toHaveAttribute('title');
  expect(screen.getByTestId('status-bar')).not.toHaveClass('bg-warning-container');
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh mail' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Pause sync' })).toBeEnabled();
  expect(screen.getByTestId('status-bar').querySelector('.size-chip-dot')).not.toHaveClass(
    'bg-error',
  );
});

it('restores the previous status presentation after suspension clears', async () => {
  overrideTraversal('backfilling');
  setStatus('error', { ...emptyQueue, suspended: true });
  renderStatusBar(<StatusBar accountId="account-1" />);
  await screen.findByText('Sync resumes shortly');

  setStatus('error');
  expect(await screen.findByText('Downloading mail')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Refresh mail' })).toBeEnabled();
});

it('keeps a user pause ahead of the reconnect state', async () => {
  setStatus('error', { ...emptyQueue, pending: 3, paused: true, suspended: true });
  renderStatusBar(<StatusBar accountId="account-1" />);
  expect(await screen.findByText('Paused · 3 queued')).toBeInTheDocument();
  expect(screen.queryByText('Sync resumes shortly')).not.toBeInTheDocument();
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
    lastSyncedAt: getTime(parseISO('2026-08-11T10:00:00Z')),
    lastError: null,
  });
  renderStatusBar(<StatusBar accountId="account-1" />);
  expect(await screen.findByText("Couldn't sync")).toHaveAttribute('title', 'Gmail is unavailable');
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(/Synced/));
  log.mockRestore();
  failure.mockRestore();
});

it('seeds last-synced from read_sync_status at mount, before any sync completes', async () => {
  ipc.override('read_sync_status', {
    accountId: 'account-1',
    state: 'idle',
    lastSyncedAt: getTime(parseISO('2026-08-11T09:30:00Z')),
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
    lastSyncedAt: getTime(parseISO('2026-08-11T09:30:00Z')),
    lastError: null,
  });
  ipc.override('trigger_sync', {
    accountId: 'account-1',
    state: 'idle',
    lastSyncedAt: getTime(parseISO('2026-08-11T10:00:00Z')),
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

it('does not announce a background tick; a manual refresh does', async () => {
  const log = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const user = userEvent.setup();
  let finish:
    | ((value: { accountId: string; state: 'idle'; lastSyncedAt: number; lastError: null }) => void)
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
    finish?.({
      accountId: 'account-1',
      state: 'idle',
      lastSyncedAt: getTime(parseISO('2026-08-11T10:00:00Z')),
      lastError: null,
    });
  });
  await waitFor(() => expect(screen.queryByText('Checking for new mail…')).not.toBeInTheDocument());
  log.mockRestore();
});
