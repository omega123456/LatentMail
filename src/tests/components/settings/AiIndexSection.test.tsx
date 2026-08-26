import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AiIndexSection } from '@/components/settings/AiIndexSection';
import { ipc } from '@/tests/ipc-mock';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

it.each([
  ['notStarted', 'Not started', 'Start'],
  ['preparing', 'Preparing index', null],
  ['complete', 'Index complete', 'Rebuild'],
  ['partial', 'Partial', 'Resume'],
  ['unavailable', 'Unavailable', 'Start'],
] as const)('renders the %s state explicitly', (state, label, action) => {
  renderWithQueryClient(
    <AiIndexSection
      accountId="account-a"
      status={{
        accountId: 'account-a',
        state,
        indexed: 99,
        total: 100,
        indexedMessages: 2,
        totalEligibleMessages: 4,
        indexedPassages: 6,
        paused: false,
        error: null,
      }}
    />,
  );
  expect(screen.getByText(label)).toBeInTheDocument();
  if (action) expect(screen.getByRole('button', { name: action })).toBeInTheDocument();
  else expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Preparing index');
});

it('renders building progress and pauses only its account', async () => {
  const user = userEvent.setup();
  const cancel = vi.fn();
  ipc.override('cancel_ai_index', (args) => {
    cancel(args.accountId);
  });
  renderWithQueryClient(
    <AiIndexSection
      accountId="account-a"
      status={{
        accountId: 'account-a',
        state: 'building',
        indexed: 99,
        total: 100,
        indexedMessages: 1250,
        totalEligibleMessages: 5000,
        indexedPassages: 3750,
        paused: false,
        error: null,
      }}
    />,
  );
  expect(screen.getByText('Building')).toBeInTheDocument();
  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '1250');
  expect(screen.getByText('1,250 of 5,000 · 25%')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(cancel).toHaveBeenCalledWith('account-a');
});

it('confirms rebuilding without affecting another account', async () => {
  const user = userEvent.setup();
  const rebuild = vi.fn();
  ipc.override('rebuild_ai_index', (args) => {
    rebuild(args.accountId);
  });
  renderWithQueryClient(
    <AiIndexSection
      accountId="account-a"
      status={{
        accountId: 'account-a',
        state: 'complete',
        indexed: 99,
        total: 100,
        indexedMessages: 5000,
        totalEligibleMessages: 5000,
        indexedPassages: 15000,
        paused: false,
        error: null,
      }}
    />,
  );
  expect(screen.getByText('5,000 messages · 15,000 passages')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Rebuild' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Rebuild the whole index?');
  await user.click(screen.getByRole('button', { name: 'Rebuild' }));
  expect(rebuild).toHaveBeenCalledWith('account-a');
});

it('keeps an interrupted error visible and resumes a paused index', async () => {
  const { rerender } = renderWithQueryClient(
    <AiIndexSection
      accountId="account-a"
      status={{
        accountId: 'account-a',
        state: 'interrupted',
        indexed: 99,
        total: 100,
        indexedMessages: 10,
        totalEligibleMessages: 50,
        indexedPassages: 30,
        paused: false,
        error: 'Provider unavailable',
      }}
    />,
  );
  expect(screen.getByText('Interrupted')).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveTextContent('Provider unavailable');
  rerender(
    <AiIndexSection
      accountId="account-a"
      status={{
        accountId: 'account-a',
        state: 'paused',
        indexed: 99,
        total: 100,
        indexedMessages: 10,
        totalEligibleMessages: 50,
        indexedPassages: 30,
        paused: true,
        error: null,
      }}
    />,
  );
  expect(screen.getByText('Paused')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Resume' })).toBeInTheDocument();
});

it('explains a needsRebuild index, offers no Resume, and reaches the Rebuild control', async () => {
  const user = userEvent.setup();
  const rebuild = vi.fn();
  ipc.override('rebuild_ai_index', (args) => {
    rebuild(args.accountId);
  });
  renderWithQueryClient(
    <AiIndexSection
      accountId="account-a"
      status={{
        accountId: 'account-a',
        state: 'needsRebuild',
        indexed: 99,
        total: 100,
        indexedMessages: 5000,
        totalEligibleMessages: 5000,
        indexedPassages: 15000,
        paused: false,
        error: null,
      }}
    />,
  );
  expect(screen.getByText('Rebuild required')).toBeInTheDocument();
  expect(screen.getByText(/built with the previous distance measure/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
  await user.click(screen.getAllByRole('button', { name: 'Rebuild' })[0]);
  expect(screen.getByRole('alert')).toHaveTextContent('Rebuild the whole index?');
  await user.click(screen.getByRole('button', { name: 'Rebuild' }));
  expect(rebuild).toHaveBeenCalledWith('account-a');
});
