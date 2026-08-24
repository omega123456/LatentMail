import { Brain, Compass, Layers, Zap, type LucideIcon } from 'lucide-react';
import type { AccountQueueSnapshot, Lane, LaneState, OperationStatus } from '@/lib/types/ipc';

export const LANE_META: Record<Lane, { label: string; Icon: LucideIcon }> = {
  interactive: { label: 'Interactive', Icon: Zap },
  background: { label: 'Background', Icon: Layers },
  traversal: { label: 'Traversal', Icon: Compass },
  embedding: { label: 'Embedding', Icon: Brain },
};

const PIP_SOLID = 'bg-settings-outline dark:bg-dark-settings-outline';
const PIP_HOLLOW = 'bg-transparent shadow-pip-hollow dark:shadow-dark-pip-hollow';
const PIP_ACTIVE = 'bg-settings-primary dark:bg-dark-settings-primary';
const PIP_BLOCKED = 'bg-settings-blocked dark:bg-dark-settings-blocked';
const PIP_QUOTA = 'bg-settings-amber dark:bg-dark-settings-amber';
const PIP_FAILED = 'bg-settings-error dark:bg-dark-settings-error';

const INK_MUTE = 'text-settings-ink-mute dark:text-dark-settings-ink-mute';

export const LANE_STATE_META: Record<
  LaneState,
  {
    label: string;
    railClass: string;
    washClass: string;
    iconClass: string;
    nameClass: string;
    chipClass: string;
    pipClass: string;
  }
> = {
  running: {
    label: 'Running',
    railClass: 'bg-settings-primary dark:bg-dark-settings-primary',
    washClass: 'bg-settings-tint-run dark:bg-dark-settings-tint-run',
    iconClass: 'text-settings-primary dark:text-dark-settings-primary',
    nameClass: 'text-settings-ink dark:text-dark-settings-ink',
    chipClass: 'text-settings-primary dark:text-dark-settings-primary',
    pipClass: PIP_ACTIVE,
  },
  blocked: {
    label: 'Waiting on interactive work',
    railClass: 'bg-settings-blocked dark:bg-dark-settings-blocked',
    washClass: 'bg-settings-tint-block dark:bg-dark-settings-tint-block',
    iconClass: 'text-settings-blocked dark:text-dark-settings-blocked',
    nameClass: 'text-settings-ink dark:text-dark-settings-ink',
    chipClass: 'text-settings-blocked dark:text-dark-settings-blocked',
    pipClass: PIP_BLOCKED,
  },
  paused: {
    label: 'Paused by you',
    railClass: 'bg-settings-outline dark:bg-dark-settings-outline',
    washClass: 'bg-settings-tint-pause dark:bg-dark-settings-tint-pause',
    iconClass: 'text-settings-outline dark:text-dark-settings-outline',
    nameClass: 'text-settings-ink dark:text-dark-settings-ink',
    chipClass: INK_MUTE,
    pipClass: PIP_SOLID,
  },
  idle: {
    label: 'Idle — nothing queued',
    railClass: 'bg-transparent',
    washClass: '',
    iconClass: 'text-settings-outline-variant dark:text-dark-settings-outline-variant',
    nameClass: `font-medium ${INK_MUTE}`,
    chipClass: INK_MUTE,
    pipClass: PIP_HOLLOW,
  },
};

export const OPERATION_STATUS_META: Record<
  OperationStatus,
  { label: string; pipClass: string; chipClass: string }
> = {
  queued: { label: 'Queued', pipClass: PIP_HOLLOW, chipClass: INK_MUTE },
  active: {
    label: 'Active',
    pipClass: PIP_ACTIVE,
    chipClass: 'text-settings-primary dark:text-dark-settings-primary',
  },
  retrying: {
    label: 'Retrying',
    pipClass: PIP_QUOTA,
    chipClass: 'text-settings-amber dark:text-dark-settings-amber',
  },
  done: { label: 'Done', pipClass: PIP_SOLID, chipClass: INK_MUTE },
  failed: {
    label: 'Failed',
    pipClass: PIP_FAILED,
    chipClass: 'font-semibold text-settings-error dark:text-dark-settings-error',
  },
  cancelled: { label: 'Cancelled', pipClass: PIP_SOLID, chipClass: INK_MUTE },
};

export type AccountBarState = 'running' | 'paused' | 'idle';

const ACCOUNT_BAR_CLASSES: Record<
  AccountBarState,
  { barClass: string; inkClass: string; pipClass: string; borderClass: string }
> = {
  running: {
    barClass: 'bg-settings-bar dark:bg-dark-settings-bar',
    inkClass: 'text-settings-bar-ink dark:text-dark-settings-bar-ink',
    pipClass: 'bg-settings-bar-ink/90 dark:bg-dark-settings-bar-ink/90',
    borderClass: 'border-settings-bar dark:border-dark-settings-bar',
  },
  paused: {
    barClass: 'bg-settings-bar-pause dark:bg-dark-settings-bar-pause',
    inkClass: 'text-settings-bar-pause-ink dark:text-dark-settings-bar-pause-ink',
    pipClass: 'bg-settings-bar-pause-ink/90 dark:bg-dark-settings-bar-pause-ink/90',
    borderClass: 'border-settings-outline-variant dark:border-dark-settings-outline-variant',
  },
  idle: {
    barClass: 'bg-settings-bar-idle dark:bg-dark-settings-bar-idle',
    inkClass: 'text-settings-bar-idle-ink dark:text-dark-settings-bar-idle-ink',
    pipClass: 'bg-settings-outline dark:bg-dark-settings-outline',
    borderClass: 'border-settings-card-line dark:border-dark-settings-card-line',
  },
};

export function describeAccountBar(snapshot: AccountQueueSnapshot): {
  state: AccountBarState;
  statusLabel: string;
  queuedLabel: string;
  failedLabel: string | null;
  barClass: string;
  inkClass: string;
  pipClass: string;
  borderClass: string;
} {
  const pausedLanes = snapshot.lanes.filter((lane) => lane.state === 'paused');
  const isWorking = snapshot.active > 0 || snapshot.queued > 0;
  const state: AccountBarState = pausedLanes.length > 0 ? 'paused' : isWorking ? 'running' : 'idle';
  const statusLabel =
    state === 'paused'
      ? pausedLanes.length === snapshot.lanes.length
        ? 'Paused'
        : 'Partly paused'
      : state === 'running'
        ? `${snapshot.active} active`
        : 'Idle';
  const queuedLabel =
    snapshot.queued > 0 ? `${snapshot.queued.toLocaleString()} queued` : 'Nothing queued';
  return {
    state,
    statusLabel,
    queuedLabel,
    failedLabel: snapshot.failed > 0 ? `${snapshot.failed} failed` : null,
    ...ACCOUNT_BAR_CLASSES[state],
  };
}

export function hasRetryableFailure(snapshots: AccountQueueSnapshot[]): boolean {
  return snapshots.some((snapshot) =>
    snapshot.lanes.some((lane) =>
      lane.operations.some((operation) => operation.status === 'failed' && operation.retryable),
    ),
  );
}
