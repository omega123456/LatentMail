import { useEffect } from 'react';
import { differenceInMinutes, format } from 'date-fns';
import { ListChecks, Loader2, Pause, Play, RefreshCw } from 'lucide-react';
import { exactTime } from '@/lib/format/relative-time';
import { useNow } from '@/lib/format/use-now';
import { invoke } from '@/lib/ipc/commands';
import { useTraversalStatusQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsUiStore } from '@/stores/settings-ui';
import { useSyncStore } from '@/stores/sync';
import type { TraversalStatus } from '@/lib/types/ipc';

const MINUTES_PER_HOUR = 60;

const barClass =
  'flex h-status-bar-h items-stretch justify-between gap-stack-gap-md px-container-padding text-label-sm';
const restingBarClass = `${barClass} border-t border-outline-variant text-on-surface-variant dark:border-dark-outline-variant dark:text-dark-on-surface-variant`;
const pausedBarClass = `${barClass} border-t border-on-warning-container/20 bg-warning-container text-on-warning-container dark:border-dark-on-warning-container/20 dark:bg-dark-warning-container dark:text-dark-on-warning-container`;

const controlClass =
  'inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50';
const restingControlClass = `${controlClass} hover:bg-surface-container-high focus-visible:bg-surface-container-high dark:hover:bg-dark-surface-container-high dark:focus-visible:bg-dark-surface-container-high`;
const pausedControlClass = `${controlClass} hover:bg-on-warning-container/10 focus-visible:bg-on-warning-container/10 dark:hover:bg-dark-on-warning-container/10 dark:focus-visible:bg-dark-on-warning-container/10`;

const queueClass =
  'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-sm px-2 focus-visible:outline-2 focus-visible:outline-primary';
const restingQueueClass = `${queueClass} hover:bg-surface-container-high focus-visible:bg-surface-container-high dark:hover:bg-dark-surface-container-high dark:focus-visible:bg-dark-surface-container-high`;
const pausedQueueClass = `${queueClass} hover:bg-on-warning-container/10 focus-visible:bg-on-warning-container/10 dark:hover:bg-dark-on-warning-container/10 dark:focus-visible:bg-dark-on-warning-container/10`;

function freshness(lastSynced: Date | null, now: Date) {
  if (!lastSynced) return 'Not yet synced';
  const minutes = Math.max(0, differenceInMinutes(now, lastSynced));
  if (minutes === 0) return 'Synced just now';
  if (minutes < MINUTES_PER_HOUR) return `Synced ${minutes}m ago`;
  return `Synced at ${format(lastSynced, 'p')}`;
}

function traversalLabel(traversal: TraversalStatus) {
  if (traversal.state === 'reconciling') return 'Verifying mail';
  return traversal.isResumed ? 'Resuming download' : 'Downloading mail';
}

function activeTraversal(traversal: TraversalStatus | undefined) {
  if (!traversal) return null;
  return traversal.state === 'backfilling' || traversal.state === 'reconciling' ? traversal : null;
}

function ProgressTrack({ traversal }: { traversal: TraversalStatus }) {
  const { persistedCount, discoveredCount } = traversal;
  const percent =
    discoveredCount === 0 ? 0 : Math.min(100, (persistedCount / discoveredCount) * 100);
  return (
    <div
      role="progressbar"
      aria-label="Sync progress"
      aria-valuemin={0}
      aria-valuemax={discoveredCount}
      aria-valuenow={persistedCount}
      aria-valuetext={`${persistedCount.toLocaleString()} of ${discoveredCount.toLocaleString()} messages`}
      className="flex items-center gap-stack-gap-sm"
    >
      <span className="tabular-nums">{`${persistedCount.toLocaleString()} / ${discoveredCount.toLocaleString()}`}</span>
      <span className="h-0.5 w-progress-track overflow-hidden rounded-full bg-outline-variant dark:bg-dark-outline-variant">
        <span
          className="block h-full rounded-full bg-primary dark:bg-dark-primary"
          style={{ width: `${percent}%` }}
        />
      </span>
    </div>
  );
}

export function StatusBar({ accountId = null }: { accountId?: string | null }) {
  const { queue, lastSynced, syncState, error, refreshing } = useSyncStore();
  const setRoute = useLayoutStore((state) => state.setRoute);
  const setActiveSection = useSettingsUiStore((state) => state.setActiveSection);
  const now = useNow(30_000);
  const traversal = activeTraversal(useTraversalStatusQuery(accountId).data);

  useEffect(() => {
    void useSyncStore.getState().hydrate();
    if (accountId) void useSyncStore.getState().hydrateSync(accountId);
  }, [accountId]);

  const paused = queue.paused;
  const failed = syncState === 'error' && !paused;
  const working = !paused && (traversal !== null || refreshing);
  const refresh = () => {
    if (accountId) void useSyncStore.getState().triggerSync(accountId);
  };
  const togglePaused = () => {
    const command = paused ? 'resume_queue' : 'pause_queue';
    void invoke(command, {}).then((summary) => useSyncStore.getState().setQueue(summary));
  };

  const label = paused
    ? `Paused · ${queue.pending} queued`
    : traversal
      ? traversalLabel(traversal)
      : refreshing
        ? 'Checking for new mail…'
        : failed
          ? "Couldn't sync"
          : freshness(lastSynced, now);

  const dotClass = failed
    ? 'bg-error dark:bg-dark-error'
    : paused
      ? 'bg-on-warning-container dark:bg-dark-on-warning-container'
      : 'bg-outline dark:bg-dark-outline';

  const showQueue = queue.pending > 0 || queue.failed > 0;

  return (
    <footer data-testid="status-bar" className={paused ? pausedBarClass : restingBarClass}>
      <div className="flex min-w-0 items-center gap-stack-gap-sm">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {working ? (
            <Loader2 aria-hidden="true" size={14} className="motion-safe:animate-spin" />
          ) : (
            <span className={`size-chip-dot rounded-full ${dotClass}`} />
          )}
        </span>
        <span
          role="status"
          aria-live="polite"
          className={`truncate ${failed ? 'text-error dark:text-dark-error' : ''}`}
          title={failed ? error : lastSynced ? exactTime(lastSynced) : undefined}
        >
          {label}
        </span>
        {traversal && <ProgressTrack traversal={traversal} />}
        {failed && (
          <button
            type="button"
            onClick={refresh}
            className="shrink-0 cursor-pointer underline hover:no-underline"
          >
            Retry
          </button>
        )}
        {!paused && (
          <button
            type="button"
            disabled={!accountId || refreshing}
            aria-label="Refresh mail"
            title="Refresh mail"
            onClick={refresh}
            className={restingControlClass}
          >
            <RefreshCw aria-hidden="true" size={14} />
          </button>
        )}
        <button
          type="button"
          aria-label={paused ? 'Resume sync' : 'Pause sync'}
          title={paused ? 'Resume sync' : 'Pause sync'}
          onClick={togglePaused}
          className={paused ? pausedControlClass : restingControlClass}
        >
          {paused ? <Play aria-hidden="true" size={14} /> : <Pause aria-hidden="true" size={14} />}
        </button>
      </div>
      {showQueue && (
        <div className="flex items-center">
          <button
            type="button"
            aria-label="Open queue settings"
            onClick={() => {
              setActiveSection('queue');
              setRoute('settings');
            }}
            className={paused ? pausedQueueClass : restingQueueClass}
          >
            <ListChecks aria-hidden="true" size={14} />
            <span
              className={`tabular-nums ${queue.failed > 0 ? 'text-error dark:text-dark-error' : ''}`}
            >
              {queue.failed > 0 ? `${queue.failed} failed` : `${queue.pending} queued`}
            </span>
          </button>
        </div>
      )}
    </footer>
  );
}
