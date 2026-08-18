import { Pause, Play } from 'lucide-react';
import type { LaneSnapshot } from '@/lib/types/ipc';
import { LANE_META, LANE_STATE_META } from '@/lib/queue/describe';
import { LaneOccupancy } from './LaneOccupancy';
import { QueueStateChip } from './QueueStateChip';
import { QueueOperationList } from './QueueOperationList';

export function QueueLaneRow({
  lane,
  expanded,
  onToggleExpand,
  onTogglePause,
  onCancelOperation,
  onRetryOperation,
}: {
  lane: LaneSnapshot;
  expanded: boolean;
  onToggleExpand: () => void;
  onTogglePause: () => void;
  onCancelOperation: (operationId: string) => Promise<boolean>;
  onRetryOperation: (operationId: string) => void;
}) {
  const meta = LANE_META[lane.lane];
  const stateMeta = LANE_STATE_META[lane.state];
  const idle = lane.state === 'idle';
  const LaneIcon = meta.Icon;
  const paused = lane.state === 'paused';

  return (
    <div>
      <div className={`relative flex h-queue-lane-h items-center ${stateMeta.washClass}`}>
        <span
          aria-hidden="true"
          className={`absolute inset-y-2 left-0 w-0.75 rounded-full ${stateMeta.railClass}`}
        />
        <button
          type="button"
          onClick={onToggleExpand}
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Collapse' : 'Expand'} the ${meta.label} lane`}
          className="flex h-full flex-1 cursor-pointer items-center gap-3 pl-queue-indent-lane text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-settings-primary"
        >
          <LaneIcon aria-hidden="true" size={13} className={stateMeta.iconClass} />
          <span className={`min-w-24 text-settings-lane uppercase ${stateMeta.nameClass}`}>
            {meta.label}
          </span>
          <LaneOccupancy capacity={lane.capacity} active={lane.active} muted={idle} />
          {lane.backlog > 0 && (
            <span className="whitespace-nowrap text-settings-meta tabular-nums text-settings-ink-mute dark:text-dark-settings-ink-mute">
              {lane.backlog.toLocaleString()} queued
            </span>
          )}
          <span className="flex-1" />
          <QueueStateChip
            pipClassName={stateMeta.pipClass}
            label={stateMeta.label}
            className={stateMeta.chipClass}
          />
        </button>
        <button
          type="button"
          aria-label={`${paused ? 'Resume' : 'Pause'} the ${meta.label} lane for this account`}
          onClick={onTogglePause}
          className="mx-3.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded-chip text-settings-ink-mute hover:bg-settings-container hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container dark:hover:text-dark-settings-ink"
        >
          {paused ? <Play aria-hidden="true" size={13} /> : <Pause aria-hidden="true" size={13} />}
        </button>
      </div>
      {expanded && (
        <QueueOperationList
          operations={lane.operations}
          onCancel={onCancelOperation}
          onRetry={onRetryOperation}
        />
      )}
    </div>
  );
}
