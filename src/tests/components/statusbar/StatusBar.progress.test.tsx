import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StatusBar } from '@/components/statusbar/StatusBar';
import { ipc } from '@/tests/ipc-mock';
import { useSettingsUiStore } from '@/stores/settings-ui';
import {
  overrideTraversal,
  renderStatusBar,
  resetStatusBarSyncStore,
  setStatus,
} from '@/tests/components/statusbar/status-bar-helpers';

afterEach(() => resetStatusBarSyncStore());

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

it('shows aggregate indexing progress unless downloading mail takes precedence', async () => {
  ipc.override('read_ai_index_status', [
    {
      accountId: 'account-1',
      state: 'building',
      indexed: 1200,
      total: 5000,
      indexedMessages: 1200,
      totalEligibleMessages: 5000,
      indexedPassages: 3600,
      paused: false,
      error: null,
    },
    {
      accountId: 'account-2',
      state: 'building',
      indexed: 400,
      total: 1000,
      indexedMessages: 400,
      totalEligibleMessages: 1000,
      indexedPassages: 1200,
      paused: false,
      error: null,
    },
  ]);
  const { unmount } = renderStatusBar(<StatusBar accountId="account-1" />);
  expect(await screen.findByText('Indexing mail')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', 'Index progress');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1600');
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '6000');
  overrideTraversal('backfilling');
  unmount();
  renderStatusBar(<StatusBar accountId="account-1" />);
  expect(await screen.findByText('Downloading mail')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-label', 'Sync progress');
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

  setStatus('idle', {
    pending: 4,
    active: 0,
    failed: 0,
    done: 0,
    paused: false,
    suspended: false,
  });
  rerender(
    <QueryClientProvider client={new QueryClient()}>
      <StatusBar />
    </QueryClientProvider>,
  );
  expect(screen.getByRole('button', { name: 'Open queue settings' })).toHaveTextContent('4 queued');

  setStatus('idle', {
    pending: 4,
    active: 0,
    failed: 2,
    done: 0,
    paused: false,
    suspended: false,
  });
  expect(screen.getByRole('button', { name: 'Open queue settings' })).toHaveTextContent('2 failed');
});

it('pauses and resumes through the queue commands while keeping refresh disabled without an account', async () => {
  const user = userEvent.setup();
  setStatus('idle');
  ipc.override('pause_queue', {
    pending: 2,
    active: 0,
    failed: 0,
    done: 0,
    paused: true,
    suspended: false,
  });
  ipc.override('resume_queue', {
    pending: 0,
    active: 0,
    failed: 0,
    done: 0,
    paused: false,
    suspended: false,
  });
  renderStatusBar(<StatusBar />);
  await user.click(screen.getByRole('button', { name: 'Pause sync' }));
  await waitFor(() => expect(screen.getByText('Paused · 2 queued')).toBeInTheDocument());
  await user.click(screen.getByRole('button', { name: 'Resume sync' }));
  await waitFor(() => expect(screen.queryByText(/Paused/)).not.toBeInTheDocument());
  expect(screen.getByRole('button', { name: 'Refresh mail' })).toBeDisabled();
});

it('selects the Queue settings section when the queue indicator is activated', async () => {
  const user = userEvent.setup();
  useSettingsUiStore.setState({ activeSection: 'general' });
  setStatus('idle', {
    pending: 1,
    active: 0,
    failed: 0,
    done: 0,
    paused: false,
    suspended: false,
  });
  renderStatusBar(<StatusBar />);
  await user.click(screen.getByRole('button', { name: 'Open queue settings' }));
  expect(useSettingsUiStore.getState().activeSection).toBe('queue');
});

it('shows the configured chat model and opens AI settings when activated', async () => {
  const user = userEvent.setup();
  useSettingsUiStore.setState({ activeSection: 'general' });
  ipc.override('read_ai_configs', [
    {
      accountId: 'account-1',
      email: 'a@example.com',
      displayName: 'A',
      enabled: true,
      baseUrl: null,
      chatModel: 'gpt-4o-mini',
      embeddingModel: null,
      embeddingDimensions: null,
      hasApiKey: true,
      indexPaused: false,
    },
  ]);
  setStatus('idle');
  renderStatusBar(<StatusBar accountId="account-1" />);
  const aiButton = await screen.findByRole('button', { name: 'Open AI settings' });
  expect(aiButton).toHaveTextContent('gpt-4o-mini');
  await user.click(aiButton);
  expect(useSettingsUiStore.getState().activeSection).toBe('ai');
});

it('reports AI as off when no config is enabled for the account', async () => {
  setStatus('idle');
  renderStatusBar(<StatusBar accountId="account-1" />);
  expect(await screen.findByRole('button', { name: 'Open AI settings' })).toHaveTextContent(
    'AI off',
  );
});
