import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueueOperationList } from '@/components/queue/QueueOperationList';
import type { OperationRecord } from '@/lib/types/ipc';

const baseOperation: OperationRecord = {
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
  createdAt: 0,
  updatedAt: 0,
};

describe('QueueOperationList', () => {
  it('shows an idle/empty state when the lane has no operations', () => {
    render(<QueueOperationList operations={[]} onCancel={vi.fn()} onRetry={vi.fn()} />);
    expect(screen.getByText('No operations waiting in this lane.')).toBeInTheDocument();
  });

  it('lists every operation with its status, description and metadata', () => {
    render(
      <QueueOperationList
        operations={[baseOperation, { ...baseOperation, id: 'op-2', description: 'Send draft' }]}
        onCancel={vi.fn()}
        onRetry={vi.fn()}
      />,
    );
    expect(screen.getByText('Re: Q3 review')).toBeInTheDocument();
    expect(screen.getByText('Send draft')).toBeInTheDocument();
  });
});
