import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getUnixTime } from 'date-fns';
import { describe, expect, it, vi } from 'vitest';
import { QueueOperationRow } from '@/components/queue/QueueOperationRow';
import type { OperationRecord } from '@/lib/types/ipc';

function operation(overrides: Partial<OperationRecord>): OperationRecord {
  return {
    id: 'op-1',
    accountId: 'account-1',
    lane: 'interactive',
    kind: 'send',
    description: 'Re: Q3 review',
    status: 'active',
    attempts: 1,
    error: null,
    retryable: true,
    nextAttemptAt: null,
    createdAt: getUnixTime(new Date()) - 10,
    updatedAt: getUnixTime(new Date()) - 2,
    ...overrides,
  };
}

describe('QueueOperationRow', () => {
  it('shows the description as the largest, always-visible text', () => {
    render(<QueueOperationRow operation={operation({})} onCancel={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText('Re: Q3 review')).toHaveClass('text-body-sm');
  });

  it('offers cancel for a queued operation and hides retry', () => {
    render(
      <QueueOperationRow
        operation={operation({ status: 'queued' })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Cancel Re: Q3 review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry Re: Q3 review' })).not.toBeInTheDocument();
  });

  it('offers no cancel for an already-active operation', () => {
    render(
      <QueueOperationRow
        operation={operation({ status: 'active' })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel Re: Q3 review' })).not.toBeInTheDocument();
  });

  it('offers retry only for a retryable failed operation, and shows its error', () => {
    render(
      <QueueOperationRow
        operation={operation({ status: 'failed', error: 'Gmail request failed with status 500' })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry Re: Q3 review' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Gmail request failed with status 500');
  });

  it('hides retry for a failed operation that is not retryable', () => {
    render(
      <QueueOperationRow
        operation={operation({ status: 'failed', retryable: false, error: 'boom' })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Retry Re: Q3 review' })).not.toBeInTheDocument();
  });

  it('calls onRetry with the operation id', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <QueueOperationRow
        operation={operation({ status: 'failed', error: 'boom' })}
        onCancel={vi.fn()}
        onRetry={onRetry}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Retry Re: Q3 review' }));
    expect(onRetry).toHaveBeenCalledWith('op-1');
  });

  it('surfaces a cancel-arrived-too-late message inline when the cancel does not apply', async () => {
    const user = userEvent.setup();
    render(
      <QueueOperationRow
        operation={operation({ status: 'queued' })}
        onCancel={vi.fn().mockResolvedValue(false)}
        onRetry={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel Re: Q3 review' }));
    expect(await screen.findByText('Already running — couldn’t cancel.')).toBeInTheDocument();
  });

  it('does not show the inline cancel-failure message when the cancel applies', async () => {
    const user = userEvent.setup();
    render(
      <QueueOperationRow
        operation={operation({ status: 'queued' })}
        onCancel={vi.fn().mockResolvedValue(true)}
        onRetry={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel Re: Q3 review' }));
    expect(screen.queryByText('Already running — couldn’t cancel.')).not.toBeInTheDocument();
  });

  it('shows attempt progress and a next-attempt countdown while retrying', () => {
    render(
      <QueueOperationRow
        operation={operation({
          status: 'retrying',
          attempts: 2,
          nextAttemptAt: getUnixTime(new Date()) + 30,
        })}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText(/Attempt 2/)).toBeInTheDocument();
  });
});
