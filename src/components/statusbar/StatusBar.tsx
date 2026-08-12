import { useEffect, useState } from 'react';
import { differenceInMinutes } from 'date-fns';
import { ListChecks, Loader2, Pause, Play, RefreshCw } from 'lucide-react';
import { exactTime } from '@/lib/format/relative-time';
import { invoke } from '@/lib/ipc/commands';
import { useTraversalStatusQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import { useSyncStore } from '@/stores/sync';

function elapsed(date: Date | null, now: Date) {
  if (!date) return 'Not yet synced';
  const minutes = Math.max(0, differenceInMinutes(now, date));
  return minutes === 0 ? 'Synced just now' : `Synced ${minutes}m ago`;
}

function LeftZone({ accountId }: { accountId: string | null }) {
  const { queue, lastSynced, syncState, error, refreshing } = useSyncStore();
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const togglePaused = () => {
    const command = queue.paused ? 'resume_queue' : 'pause_queue';
    void invoke(command, {}).then((summary) => useSyncStore.getState().setQueue(summary));
  };
  const refresh = () => {
    if (accountId) void useSyncStore.getState().triggerSync(accountId);
  };
  const label = queue.paused
    ? `Paused — ${queue.pending} queued`
    : syncState === 'error'
      ? 'Sync failed'
      : elapsed(lastSynced, now);
  return (
    <div className="flex min-w-0 items-center gap-stack-gap-sm">
      <button
        type="button"
        aria-label={queue.paused ? 'Resume sync' : 'Pause sync'}
        title={queue.paused ? 'Resume sync' : 'Pause sync'}
        onClick={togglePaused}
        className="rounded p-stack-gap-sm text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface"
      >
        {queue.paused ? (
          <Play aria-hidden="true" size={16} />
        ) : (
          <Pause aria-hidden="true" size={16} />
        )}
      </button>
      <span title={syncState === 'error' ? error : lastSynced ? exactTime(lastSynced) : undefined}>
        {label}
      </span>
      <button
        type="button"
        disabled={!accountId || refreshing}
        aria-label="Refresh mail"
        onClick={refresh}
        className="rounded p-stack-gap-sm disabled:opacity-50"
      >
        <RefreshCw
          aria-hidden="true"
          size={16}
          className={refreshing ? 'animate-spin' : undefined}
        />
      </button>
    </div>
  );
}

function ProgressZone({ accountId }: { accountId: string | null }) {
  const syncing = useSyncStore((state) => state.syncState === 'syncing');
  const traversal = useTraversalStatusQuery(accountId);
  const status = traversal.data;
  if (status?.state === 'backfilling') {
    const verb = status.isResumed ? 'Resuming backfill' : 'Backfilling';
    return (
      <div className="flex items-center gap-stack-gap-sm tabular-nums">
        <Loader2 aria-hidden="true" size={16} className="animate-spin" />
        <span>{`${verb} · ${status.persistedCount.toLocaleString()} / ${status.discoveredCount.toLocaleString()}`}</span>
      </div>
    );
  }
  if (status?.state === 'reconciling')
    return (
      <div className="flex items-center gap-stack-gap-sm tabular-nums">
        <Loader2 aria-hidden="true" size={16} className="animate-spin" />
        <span>{`Reconciling · ${status.persistedCount.toLocaleString()} / ${status.discoveredCount.toLocaleString()}`}</span>
      </div>
    );
  return syncing ? (
    <div className="flex items-center gap-stack-gap-sm">
      <Loader2 aria-hidden="true" size={16} className="animate-spin" />
      <span>Syncing…</span>
    </div>
  ) : null;
}

function RightZone({ accountCount }: { accountCount: number }) {
  const pending = useSyncStore((state) => state.queue.pending);
  const setRoute = useLayoutStore((state) => state.setRoute);
  return (
    <div className="flex items-center gap-stack-gap-md">
      <span>
        {accountCount} {accountCount === 1 ? 'account' : 'accounts'}
      </span>
      <button
        type="button"
        aria-label="Open queue settings"
        onClick={() => setRoute('settings')}
        className="flex items-center gap-stack-gap-sm rounded p-stack-gap-sm focus-visible:outline-2 focus-visible:outline-primary"
      >
        <ListChecks aria-hidden="true" size={16} />
        {pending}
      </button>
    </div>
  );
}

export function StatusBar({
  accountCount,
  accountId = null,
}: {
  accountCount: number;
  accountId?: string | null;
}) {
  useEffect(() => {
    void useSyncStore.getState().hydrate();
    if (accountId) void useSyncStore.getState().hydrateSync(accountId);
  }, [accountId]);
  return (
    <footer
      data-testid="status-bar"
      className="grid grid-cols-3 items-center border-t border-outline-variant px-container-padding py-stack-gap-sm text-label-sm text-on-surface-variant dark:border-dark-outline-variant dark:text-dark-on-surface-variant"
    >
      <LeftZone accountId={accountId} />
      <div className="justify-self-center">
        <ProgressZone accountId={accountId} />
      </div>
      <div className="justify-self-end">
        <RightZone accountCount={accountCount} />
      </div>
    </footer>
  );
}
