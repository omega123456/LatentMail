import { Pause, Play } from 'lucide-react';
import { Avatar } from '@/components/shared/Avatar';
import { describeAccountBar } from '@/lib/queue/describe';
import { laneKey, useSettingsUiStore } from '@/stores/settings-ui';
import type { Account, AccountQueueSnapshot, Lane } from '@/lib/types/ipc';
import { QueueLaneRow } from './QueueLaneRow';

export function QueueAccountCard({
  account,
  snapshot,
  onTogglePause,
  onCancelOperation,
  onRetryOperation,
}: {
  account: Account | undefined;
  snapshot: AccountQueueSnapshot;
  onTogglePause: (accountId: string, lane: Lane | undefined, paused: boolean) => void;
  onCancelOperation: (operationId: string) => Promise<boolean>;
  onRetryOperation: (operationId: string) => void;
}) {
  const expandedLanes = useSettingsUiStore((state) => state.expandedLanes);
  const toggleLaneExpanded = useSettingsUiStore((state) => state.toggleLaneExpanded);
  const bar = describeAccountBar(snapshot);
  const allLanesPaused = snapshot.lanes.every((lane) => lane.state === 'paused');
  const label = account?.displayName ?? snapshot.accountId;

  return (
    <div
      data-testid={`queue-account-card-${snapshot.accountId}`}
      className={`overflow-hidden rounded-card border bg-settings-card dark:bg-dark-settings-card ${bar.borderClass}`}
    >
      <div
        className={`flex h-queue-bar-h items-center gap-2.75 pl-3.25 pr-3.5 ${bar.barClass} ${bar.inkClass}`}
      >
        <Avatar
          size={24}
          src={account?.avatarUrl ?? null}
          label={label}
          fallbackClassName="text-avatar-sm bg-white/22"
        />
        <span className="min-w-0 truncate text-body-sm font-semibold">{label}</span>
        <span className="flex-1" />
        <span aria-live="polite" className="inline-flex items-center gap-1.75 text-settings-meta">
          <span aria-hidden="true" className={`size-1.75 shrink-0 rounded-full ${bar.pipClass}`} />
          {bar.statusLabel}
        </span>
        <span className="ml-4.5 whitespace-nowrap text-settings-meta tabular-nums">
          {bar.queuedLabel}
        </span>
        {bar.failedLabel && (
          <span className="ml-4.5 inline-flex items-center gap-1.75 text-settings-meta">
            <span
              aria-hidden="true"
              className="size-1.75 shrink-0 rounded-full bg-settings-bar-pip-failed dark:bg-dark-settings-bar-pip-failed"
            />
            {bar.failedLabel}
          </span>
        )}
        <button
          type="button"
          aria-label={`${allLanesPaused ? 'Resume' : 'Pause'} queued work for ${label}`}
          onClick={() => onTogglePause(snapshot.accountId, undefined, !allLanesPaused)}
          className="ml-4.5 grid size-6 shrink-0 cursor-pointer place-items-center rounded-chip opacity-85 hover:opacity-100 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-current"
        >
          {allLanesPaused ? (
            <Play aria-hidden="true" size={13} />
          ) : (
            <Pause aria-hidden="true" size={13} />
          )}
        </button>
      </div>
      {snapshot.lanes.map((lane) => (
        <QueueLaneRow
          key={lane.lane}
          lane={lane}
          expanded={expandedLanes.has(laneKey(snapshot.accountId, lane.lane))}
          onToggleExpand={() => toggleLaneExpanded(snapshot.accountId, lane.lane)}
          onTogglePause={() =>
            onTogglePause(snapshot.accountId, lane.lane, lane.state !== 'paused')
          }
          onCancelOperation={onCancelOperation}
          onRetryOperation={onRetryOperation}
        />
      ))}
      <div aria-hidden="true" className="h-1.5" />
    </div>
  );
}
