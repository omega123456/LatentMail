import { describe, expect, it } from 'vitest';
import { describeAccountBar, hasRetryableFailure } from '@/lib/queue/describe';
import type { AccountQueueSnapshot } from '@/lib/types/ipc';

function emptyLane(
  lane: AccountQueueSnapshot['lanes'][number]['lane'],
  state: AccountQueueSnapshot['lanes'][number]['state'],
): AccountQueueSnapshot['lanes'][number] {
  return { lane, capacity: 4, active: 0, backlog: 0, state, operations: [] };
}

function snapshot(overrides: Partial<AccountQueueSnapshot>): AccountQueueSnapshot {
  return {
    accountId: 'account-1',
    active: 0,
    queued: 0,
    failed: 0,
    lanes: [
      emptyLane('interactive', 'idle'),
      emptyLane('background', 'idle'),
      emptyLane('traversal', 'idle'),
    ],
    ...overrides,
  };
}

describe('describeAccountBar', () => {
  it('reports idle when nothing is running or paused', () => {
    const bar = describeAccountBar(snapshot({}));
    expect(bar.state).toBe('idle');
    expect(bar.statusLabel).toBe('Idle');
    expect(bar.queuedLabel).toBe('Nothing queued');
  });

  it('reports running and states the active/queued counts in text when work is in flight', () => {
    const bar = describeAccountBar(snapshot({ active: 2, queued: 1 }));
    expect(bar.state).toBe('running');
    expect(bar.statusLabel).toBe('2 active');
    expect(bar.queuedLabel).toBe('1 queued');
  });

  it('groups the queued count in thousands', () => {
    const bar = describeAccountBar(snapshot({ active: 1, queued: 8424 }));
    expect(bar.queuedLabel).toBe('8,424 queued');
  });

  it('reports partly paused when some but not all lanes are paused', () => {
    const bar = describeAccountBar(
      snapshot({
        active: 1,
        lanes: [
          emptyLane('interactive', 'running'),
          emptyLane('background', 'paused'),
          emptyLane('traversal', 'idle'),
        ],
      }),
    );
    expect(bar.state).toBe('paused');
    expect(bar.statusLabel).toBe('Partly paused');
  });

  it('reports paused when every lane is paused', () => {
    const bar = describeAccountBar(
      snapshot({
        lanes: [
          emptyLane('interactive', 'paused'),
          emptyLane('background', 'paused'),
          emptyLane('traversal', 'paused'),
        ],
      }),
    );
    expect(bar.state).toBe('paused');
    expect(bar.statusLabel).toBe('Paused');
  });

  it('states the failed count separately when failures exist', () => {
    const bar = describeAccountBar(snapshot({ failed: 2 }));
    expect(bar.state).toBe('idle');
    expect(bar.failedLabel).toBe('2 failed');
  });

  it('omits the failed count entirely when there are no failures', () => {
    const bar = describeAccountBar(snapshot({ active: 1, failed: 0 }));
    expect(bar.failedLabel).toBeNull();
  });
});

describe('hasRetryableFailure', () => {
  it('is false for an empty snapshot list', () => {
    expect(hasRetryableFailure([])).toBe(false);
  });

  it('is false when every failure is non-retryable', () => {
    const withNonRetryableFailure = snapshot({
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
              kind: 'sync',
              description: 'Sync',
              status: 'failed',
              attempts: 1,
              error: 'boom',
              retryable: false,
              nextAttemptAt: null,
              createdAt: 0,
              updatedAt: 0,
            },
          ],
        },
        emptyLane('background', 'idle'),
        emptyLane('traversal', 'idle'),
      ],
    });
    expect(hasRetryableFailure([withNonRetryableFailure])).toBe(false);
  });

  it('is true when at least one retryable failed operation exists anywhere', () => {
    const withRetryableFailure = snapshot({
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
        emptyLane('background', 'idle'),
        emptyLane('traversal', 'idle'),
      ],
    });
    expect(hasRetryableFailure([snapshot({}), withRetryableFailure])).toBe(true);
  });
});
