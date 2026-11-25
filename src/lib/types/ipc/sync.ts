export type TraversalKind = 'backfill' | 'reconciliation';

export type TraversalState = 'notStarted' | 'backfilling' | 'reconciling' | 'complete';

export interface TraversalStatus {
  accountId: string;
  state: TraversalState;
  kind: TraversalKind | null;
  discoveredCount: number;
  persistedCount: number;
  lastAdvancedAt: number | null;
  isResumed: boolean;
}

export type SyncEngineState = 'idle' | 'syncing' | 'error';

export interface SyncStatus {
  accountId: string;
  state: SyncEngineState;
  lastSyncedAt: number | null;
  lastError: string | null;
}

export interface SyncProgressEvent {
  accountId: string;
  state: SyncEngineState;
}

export interface SyncCompleteEvent {
  accountId: string;
  historyId: number;
  addedCount: number;
  changed: boolean;
  completedAt: number;
}

export interface MailArrival {
  threadId: string;
  sender: string;
  subject: string;
  snippet: string;
}

export interface NewMailEvent {
  accountId: string;
  threadIds: string[];
  arrivals: MailArrival[];
}

export interface TraversalProgressEvent {
  accountId: string;
  kind: TraversalKind;
  discoveredCount: number;
  persistedCount: number;
  completed: boolean;
  state: TraversalState;
  lastAdvancedAt: number;
  isResumed: boolean;
}

export interface AvatarResolvedEvent {
  pipeline: 'sender' | 'account';
  key: string;
  resolved: boolean;
}
