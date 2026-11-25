export interface QueueSummary {
  pending: number;
  active: number;
  failed: number;
  done: number;
  paused: boolean;
  suspended: boolean;
}

export type Lane = 'interactive' | 'background' | 'traversal' | 'embedding';

export type OperationKind =
  | 'noop'
  | 'labelMutation'
  | 'send'
  | 'draft'
  | 'sync'
  | 'star'
  | 'unstar'
  | 'markRead'
  | 'markUnread'
  | 'delete'
  | 'move'
  | 'spam'
  | 'notSpam'
  | 'traversal'
  | 'embed';

export type OperationStatus = 'queued' | 'active' | 'retrying' | 'done' | 'failed' | 'cancelled';

export type LaneState = 'paused' | 'blocked' | 'running' | 'idle';

export interface OperationRecord {
  id: string;
  accountId: string;
  lane: Lane;
  kind: OperationKind;
  description: string;
  status: OperationStatus;
  attempts: number;
  error: string | null;
  retryable: boolean;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LaneSnapshot {
  lane: Lane;
  capacity: number;
  active: number;
  backlog: number;
  state: LaneState;
  operations: OperationRecord[];
}

export interface AccountQueueSnapshot {
  accountId: string;
  active: number;
  queued: number;
  failed: number;
  lanes: LaneSnapshot[];
}

export type PauseScope =
  | { scope: 'global' }
  | { scope: 'account'; accountId: string }
  | { scope: 'lane'; accountId: string; lane: Lane };
