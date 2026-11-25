import { differenceInMinutes, format, secondsToMilliseconds } from 'date-fns';
import { exactTime } from '@/lib/format/relative-time';
import { DATE_FORMAT } from '@/lib/format/date-formats';
import type { AiConfig, TraversalStatus } from '@/lib/types/ipc';

const MINUTES_PER_HOUR = 60;
const LAST_SYNCED_REFRESH_SECONDS = 30;
export const LAST_SYNCED_REFRESH_MS = secondsToMilliseconds(LAST_SYNCED_REFRESH_SECONDS);

const barClass =
  'flex h-status-bar-h items-stretch justify-between gap-stack-gap-md px-container-padding text-label-sm';
export const restingBarClass = `${barClass} border-t border-outline-variant text-on-surface-variant dark:border-dark-outline-variant dark:text-dark-on-surface-variant`;
export const pausedBarClass = `${barClass} border-t border-on-warning-container/20 bg-warning-container text-on-warning-container dark:border-dark-on-warning-container/20 dark:bg-dark-warning-container dark:text-dark-on-warning-container`;

const controlClass =
  'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';
export const restingControlClass = `${controlClass} hover:bg-surface-container-high focus-visible:bg-surface-container-high dark:hover:bg-dark-surface-container-high dark:focus-visible:bg-dark-surface-container-high`;
export const pausedControlClass = `${controlClass} hover:bg-on-warning-container/10 focus-visible:bg-on-warning-container/10 dark:hover:bg-dark-on-warning-container/10 dark:focus-visible:bg-dark-on-warning-container/10`;

const queueClass =
  'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 focus-visible:outline-2 focus-visible:outline-primary';
export const restingQueueClass = `${queueClass} hover:bg-surface-container-high focus-visible:bg-surface-container-high dark:hover:bg-dark-surface-container-high dark:focus-visible:bg-dark-surface-container-high`;
export const pausedQueueClass = `${queueClass} hover:bg-on-warning-container/10 focus-visible:bg-on-warning-container/10 dark:hover:bg-dark-on-warning-container/10 dark:focus-visible:bg-dark-on-warning-container/10`;

export function aiModelLabel(config: AiConfig | undefined) {
  if (!config || !config.enabled) return 'AI off';
  return config.chatModel ?? 'No model selected';
}

function freshness(lastSynced: Date | null, now: Date) {
  if (!lastSynced) return 'Not yet synced';
  const minutes = Math.max(0, differenceInMinutes(now, lastSynced));
  if (minutes === 0) return 'Synced just now';
  if (minutes < MINUTES_PER_HOUR) return `Synced ${minutes}m ago`;
  return `Synced at ${format(lastSynced, DATE_FORMAT.timeOfDay)}`;
}

function traversalLabel(traversal: TraversalStatus) {
  if (traversal.state === 'reconciling') return 'Verifying mail';
  return traversal.isResumed ? 'Resuming download' : 'Downloading mail';
}

export function activeTraversal(traversal: TraversalStatus | undefined) {
  if (!traversal) return null;
  return traversal.state === 'backfilling' || traversal.state === 'reconciling' ? traversal : null;
}

export type StatusLabelInput = {
  paused: boolean;
  reconnecting: boolean;
  traversal: TraversalStatus | null;
  indexing: boolean;
  refreshing: boolean;
  failed: boolean;
  pendingCount: number;
  lastSynced: Date | null;
  now: Date;
};

export function statusLabel(input: StatusLabelInput): string {
  if (input.paused) return `Paused · ${input.pendingCount} queued`;
  if (input.reconnecting) return 'Sync resumes shortly';
  if (input.traversal) return traversalLabel(input.traversal);
  if (input.indexing) return 'Indexing mail';
  if (input.refreshing) return 'Checking for new mail…';
  if (input.failed) return "Couldn't sync";
  return freshness(input.lastSynced, input.now);
}

export function statusDotClass(failed: boolean, paused: boolean): string {
  if (failed) return 'bg-error dark:bg-dark-error';
  if (paused) return 'bg-on-warning-container dark:bg-dark-on-warning-container';
  return 'bg-outline dark:bg-dark-outline';
}

export function statusTitle(failed: boolean, error: string | undefined, lastSynced: Date | null) {
  if (failed) return error;
  if (lastSynced) return exactTime(lastSynced);
  return undefined;
}

export function deriveSyncFlags(input: {
  paused: boolean;
  suspended: boolean;
  syncState: string;
  traversal: TraversalStatus | null;
  indexing: boolean;
  refreshing: boolean;
}) {
  const reconnecting = input.suspended && !input.paused;
  const failed = input.syncState === 'error' && !input.paused && !reconnecting;
  const hasActiveWork = input.traversal !== null || input.indexing || input.refreshing;
  const working = !input.paused && !reconnecting && hasActiveWork;
  return { reconnecting: reconnecting, failed: failed, working: working };
}
