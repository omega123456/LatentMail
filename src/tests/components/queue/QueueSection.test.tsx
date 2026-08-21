import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueueSection } from '@/components/queue/QueueSection';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { useSettingsUiStore } from '@/stores/settings-ui';
import { useSyncStore } from '@/stores/sync';
import { ipc } from '@/tests/ipc-mock';
import type { AccountQueueSnapshot } from '@/lib/types/ipc';

const account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

function idleSnapshot(overrides: Partial<AccountQueueSnapshot> = {}): AccountQueueSnapshot {
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

describe('QueueSection', () => {
  beforeEach(() => {
    ipc.reset();
    act(() => {
      useSettingsUiStore.setState({ expandedLanes: new Set() });
      useSyncStore.setState({
        queue: { pending: 0, active: 0, failed: 0, done: 0, paused: false, suspended: false },
        syncState: 'idle',
        lastSynced: null,
      });
    });
  });

  it('shows a loading state before the snapshot resolves', () => {
    ipc.override('read_queue_operations', () => new Promise(() => undefined));
    renderWithQueryClient(<QueueSection />);
    expect(screen.getByText('Loading queue…')).toBeInTheDocument();
  });

  it('shows an empty state when no account is queuing work', async () => {
    ipc.override('list_accounts', []);
    ipc.override('read_queue_operations', []);
    renderWithQueryClient(<QueueSection />);
    expect(await screen.findByText('No accounts are queuing mail operations.')).toBeInTheDocument();
  });

  it('renders one card per account with correct rollups', async () => {
    ipc.override('list_accounts', [account]);
    ipc.override('read_queue_operations', [idleSnapshot({ active: 2, queued: 1 })]);
    renderWithQueryClient(<QueueSection />);
    expect(await screen.findByTestId('queue-account-card-account-1')).toBeInTheDocument();
    expect(screen.getByText('2 active')).toBeInTheDocument();
    expect(screen.getByText('1 queued')).toBeInTheDocument();
  });

  it('shows Retry all failed only when a retryable failure exists anywhere', async () => {
    ipc.override('list_accounts', [account]);
    ipc.override('read_queue_operations', [idleSnapshot({})]);
    renderWithQueryClient(<QueueSection />);
    await screen.findByTestId('queue-account-card-account-1');
    expect(screen.queryByRole('button', { name: 'Retry all failed' })).not.toBeInTheDocument();
  });

  it('renders Retry all failed and retries every failed operation on click', async () => {
    const user = userEvent.setup();
    const retryAll = vi.fn(() => 1);
    ipc.override('list_accounts', [account]);
    ipc.override('read_queue_operations', [
      idleSnapshot({
        failed: 1,
        lanes: [
          {
            lane: 'interactive',
            capacity: 4,
            active: 0,
            backlog: 0,
            state: 'idle',
            operations: [
              {
                id: 'op-1',
                accountId: 'account-1',
                lane: 'interactive',
                kind: 'send',
                description: 'Send',
                status: 'failed',
                attempts: 3,
                error: 'boom',
                retryable: true,
                nextAttemptAt: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
          { lane: 'background', capacity: 2, active: 0, backlog: 0, state: 'idle', operations: [] },
          { lane: 'traversal', capacity: 1, active: 0, backlog: 0, state: 'idle', operations: [] },
        ],
      }),
    ]);
    ipc.override('retry_failed_operations', retryAll);
    renderWithQueryClient(<QueueSection />);
    await user.click(await screen.findByRole('button', { name: 'Retry all failed' }));
    expect(retryAll).toHaveBeenCalledWith({ accountId: null });
  });

  it('clears queue history globally through the mutation wired from the section', async () => {
    const user = userEvent.setup();
    const clearHistory = vi.fn();
    ipc.override('list_accounts', [account]);
    ipc.override('read_queue_operations', [idleSnapshot({})]);
    ipc.override('clear_queue_history', clearHistory);
    renderWithQueryClient(<QueueSection />);
    await user.click(await screen.findByRole('button', { name: 'Clear history' }));
    expect(clearHistory).toHaveBeenCalledWith({ accountId: null });
  });

  it('agrees with the status bar paused state, and toggles the global pause scope', async () => {
    const user = userEvent.setup();
    const setPaused = vi.fn(() => true);
    ipc.override('list_accounts', [account]);
    ipc.override('read_queue_operations', [idleSnapshot({})]);
    ipc.override('set_queue_paused', setPaused);
    act(() =>
      useSyncStore.setState({
        queue: { pending: 0, active: 0, failed: 0, done: 0, paused: true, suspended: false },
        syncState: 'idle',
        lastSynced: null,
      }),
    );
    renderWithQueryClient(<QueueSection />);
    const resumeAll = await screen.findByRole('button', { name: 'Resume all queued work' });
    await user.click(resumeAll);
    expect(setPaused).toHaveBeenCalledWith({ scope: { scope: 'global' }, paused: false });
  });

  it('pauses an account and a single lane through the mutation wired from the section', async () => {
    const user = userEvent.setup();
    const setPaused = vi.fn(() => true);
    ipc.override('list_accounts', [account]);
    ipc.override('read_queue_operations', [idleSnapshot({})]);
    ipc.override('set_queue_paused', setPaused);
    renderWithQueryClient(<QueueSection />);

    await user.click(
      await screen.findByRole('button', { name: 'Pause queued work for Alex Morgan' }),
    );
    expect(setPaused).toHaveBeenCalledWith({
      scope: { scope: 'account', accountId: 'account-1' },
      paused: true,
    });

    await user.click(
      screen.getByRole('button', { name: 'Pause the Interactive lane for this account' }),
    );
    expect(setPaused).toHaveBeenCalledWith({
      scope: { scope: 'lane', accountId: 'account-1', lane: 'interactive' },
      paused: true,
    });
  });

  it('retries a single failed operation through the mutation wired from the section', async () => {
    const user = userEvent.setup();
    const retry = vi.fn(() => true);
    ipc.override('list_accounts', [account]);
    ipc.override('read_queue_operations', [
      idleSnapshot({
        failed: 1,
        lanes: [
          {
            lane: 'interactive',
            capacity: 4,
            active: 0,
            backlog: 0,
            state: 'idle',
            operations: [
              {
                id: 'op-1',
                accountId: 'account-1',
                lane: 'interactive',
                kind: 'send',
                description: 'Send',
                status: 'failed',
                attempts: 3,
                error: 'boom',
                retryable: true,
                nextAttemptAt: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
          { lane: 'background', capacity: 2, active: 0, backlog: 0, state: 'idle', operations: [] },
          { lane: 'traversal', capacity: 1, active: 0, backlog: 0, state: 'idle', operations: [] },
        ],
      }),
    ]);
    ipc.override('retry_queue_operation', retry);
    renderWithQueryClient(<QueueSection />);
    await user.click(await screen.findByRole('button', { name: 'Expand the Interactive lane' }));
    await user.click(await screen.findByRole('button', { name: 'Retry Send' }));
    await waitFor(() => expect(retry).toHaveBeenCalledWith({ operationId: 'op-1' }));
  });

  it('cancels an operation through the mutation wired from the section', async () => {
    const user = userEvent.setup();
    const cancel = vi.fn(() => false);
    ipc.override('list_accounts', [account]);
    ipc.override('read_queue_operations', [
      idleSnapshot({
        lanes: [
          {
            lane: 'interactive',
            capacity: 4,
            active: 0,
            backlog: 1,
            state: 'idle',
            operations: [
              {
                id: 'op-1',
                accountId: 'account-1',
                lane: 'interactive',
                kind: 'labelMutation',
                description: 'Add label',
                status: 'queued',
                attempts: 0,
                error: null,
                retryable: false,
                nextAttemptAt: null,
                createdAt: 0,
                updatedAt: 0,
              },
            ],
          },
          { lane: 'background', capacity: 2, active: 0, backlog: 0, state: 'idle', operations: [] },
          { lane: 'traversal', capacity: 1, active: 0, backlog: 0, state: 'idle', operations: [] },
        ],
      }),
    ]);
    ipc.override('cancel_queue_operation', cancel);
    renderWithQueryClient(<QueueSection />);
    await user.click(await screen.findByRole('button', { name: 'Expand the Interactive lane' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel Add label' }));
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ operationId: 'op-1' }));
    expect(await screen.findByText('Already running — couldn’t cancel.')).toBeInTheDocument();
  });
});
