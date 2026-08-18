import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { QueueLaneRow } from '@/components/queue/QueueLaneRow';
import type { LaneSnapshot } from '@/lib/types/ipc';

function lane(overrides: Partial<LaneSnapshot>): LaneSnapshot {
  return {
    lane: 'interactive',
    capacity: 4,
    active: 2,
    backlog: 3,
    state: 'running',
    operations: [],
    ...overrides,
  };
}

describe('QueueLaneRow', () => {
  it('shows the lane name, occupancy and backlog, plus a text label for its state', () => {
    render(
      <QueueLaneRow
        lane={lane({})}
        expanded={false}
        onToggleExpand={vi.fn()}
        onTogglePause={vi.fn()}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    expect(screen.getByText('Interactive')).toBeInTheDocument();
    expect(screen.getByText('3 queued')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('renders all four lane states with a distinct label each', () => {
    const labels = {
      running: 'Running',
      blocked: 'Waiting on interactive work',
      paused: 'Paused by you',
      idle: 'Idle — nothing queued',
    } as const;
    (['running', 'blocked', 'paused', 'idle'] as const).forEach((state) => {
      const { unmount } = render(
        <QueueLaneRow
          lane={lane({ state })}
          expanded={false}
          onToggleExpand={vi.fn()}
          onTogglePause={vi.fn()}
          onCancelOperation={vi.fn()}
          onRetryOperation={vi.fn()}
        />,
      );
      expect(screen.getByText(labels[state])).toBeInTheDocument();
      unmount();
    });
  });

  it('expands and collapses on click, revealing its operation list only when expanded', () => {
    const onToggleExpand = vi.fn();
    const { rerender } = render(
      <QueueLaneRow
        lane={lane({})}
        expanded={false}
        onToggleExpand={onToggleExpand}
        onTogglePause={vi.fn()}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    expect(screen.queryByText('No operations waiting in this lane.')).not.toBeInTheDocument();
    rerender(
      <QueueLaneRow
        lane={lane({})}
        expanded
        onToggleExpand={onToggleExpand}
        onTogglePause={vi.fn()}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    expect(screen.getByText('No operations waiting in this lane.')).toBeInTheDocument();
  });

  it('calls onToggleExpand when the row is clicked', async () => {
    const user = userEvent.setup();
    const onToggleExpand = vi.fn();
    render(
      <QueueLaneRow
        lane={lane({})}
        expanded={false}
        onToggleExpand={onToggleExpand}
        onTogglePause={vi.fn()}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Expand the Interactive lane' }));
    expect(onToggleExpand).toHaveBeenCalled();
  });

  it('exposes a lane-scoped pause control with an accessible name naming the lane', async () => {
    const user = userEvent.setup();
    const onTogglePause = vi.fn();
    render(
      <QueueLaneRow
        lane={lane({ state: 'running' })}
        expanded={false}
        onToggleExpand={vi.fn()}
        onTogglePause={onTogglePause}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    await user.click(
      screen.getByRole('button', { name: 'Pause the Interactive lane for this account' }),
    );
    expect(onTogglePause).toHaveBeenCalled();
  });

  it('offers Resume instead of Pause once the lane is already paused', () => {
    render(
      <QueueLaneRow
        lane={lane({ state: 'paused' })}
        expanded={false}
        onToggleExpand={vi.fn()}
        onTogglePause={vi.fn()}
        onCancelOperation={vi.fn()}
        onRetryOperation={vi.fn()}
      />,
    );
    expect(
      screen.getByRole('button', { name: 'Resume the Interactive lane for this account' }),
    ).toBeInTheDocument();
  });
});
