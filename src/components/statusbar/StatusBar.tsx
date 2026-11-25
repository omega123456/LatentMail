import { useEffect } from 'react';
import { ListChecks, Loader2, Pause, Play, RefreshCw, Sparkles } from 'lucide-react';
import { useNow } from '@/lib/format/use-now';
import { invoke } from '@/lib/ipc/commands';
import {
  useAiConfigsQuery,
  useAiIndexStatusesQuery,
  useTraversalStatusQuery,
} from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsUiStore } from '@/stores/settings-ui';
import { useSyncStore } from '@/stores/sync';
import type { AiConfig, TraversalStatus } from '@/lib/types/ipc';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { percentOf, WHOLE_PERCENT } from '@/lib/format/percent';
import {
  LAST_SYNCED_REFRESH_MS,
  activeTraversal,
  aiModelLabel,
  deriveSyncFlags,
  pausedBarClass,
  pausedControlClass,
  pausedQueueClass,
  restingBarClass,
  restingControlClass,
  restingQueueClass,
  statusDotClass,
  statusLabel,
  statusTitle,
} from './status-bar-helpers';

function ProgressTrack({
  completed,
  total,
  name,
  unit,
}: {
  completed: number;
  total: number;
  name: string;
  unit: string;
}) {
  const percent = Math.min(WHOLE_PERCENT, percentOf(completed, total));
  return (
    <div
      role="progressbar"
      aria-label={name}
      aria-valuemin={0}
      aria-valuemax={total}
      aria-valuenow={completed}
      aria-valuetext={`${completed.toLocaleString()} of ${total.toLocaleString()} ${unit}`}
      className="flex items-center gap-stack-gap-sm"
    >
      <span className="tabular-nums">{`${completed.toLocaleString()} / ${total.toLocaleString()}`}</span>
      <span className="h-0.5 w-progress-track overflow-hidden rounded-full bg-outline-variant dark:bg-dark-outline-variant">
        <span
          className="block h-full rounded-full bg-primary dark:bg-dark-primary"
          style={{ width: `${percent}%` }}
        />
      </span>
    </div>
  );
}

function ActiveProgress({
  traversal,
  indexing,
  reconnecting,
  index,
}: {
  traversal: TraversalStatus | null;
  indexing: boolean;
  reconnecting: boolean;
  index: { indexed: number; total: number };
}) {
  if (reconnecting) return null;
  if (traversal) {
    return (
      <ProgressTrack
        completed={traversal.persistedCount}
        total={traversal.discoveredCount}
        name="Sync progress"
        unit="messages"
      />
    );
  }
  if (!indexing) return null;
  return (
    <ProgressTrack
      completed={index.indexed}
      total={index.total}
      name="Index progress"
      unit="messages"
    />
  );
}

function StatusRightActions({
  accountId,
  aiConfig,
  paused,
  pending,
  failed,
  onOpenSection,
}: {
  accountId: string | null;
  aiConfig: AiConfig | undefined;
  paused: boolean;
  pending: number;
  failed: number;
  onOpenSection: (section: 'ai' | 'queue') => void;
}) {
  const buttonClass = paused ? pausedQueueClass : restingQueueClass;
  const showQueue = pending > 0 || failed > 0;
  return (
    <div className="flex items-center gap-stack-gap-sm">
      {accountId && (
        <button
          type="button"
          aria-label="Open AI settings"
          title={aiModelLabel(aiConfig)}
          onClick={() => onOpenSection('ai')}
          className={buttonClass}
        >
          <Sparkles aria-hidden="true" size={ICON_SIZE.sm} />
          <span className="max-w-40 truncate">{aiModelLabel(aiConfig)}</span>
        </button>
      )}
      {showQueue && (
        <button
          type="button"
          aria-label="Open queue settings"
          onClick={() => onOpenSection('queue')}
          className={buttonClass}
        >
          <ListChecks aria-hidden="true" size={ICON_SIZE.sm} />
          <span className={`tabular-nums ${failed > 0 ? 'text-error dark:text-dark-error' : ''}`}>
            {failed > 0 ? `${failed} failed` : `${pending} queued`}
          </span>
        </button>
      )}
    </div>
  );
}

function StatusSyncButtons({
  failed,
  paused,
  refreshDisabled,
  onRefresh,
  onTogglePaused,
}: {
  failed: boolean;
  paused: boolean;
  refreshDisabled: boolean;
  onRefresh: () => void;
  onTogglePaused: () => void;
}) {
  const pauseLabel = paused ? 'Resume sync' : 'Pause sync';
  return (
    <>
      {failed && (
        <button
          type="button"
          onClick={onRefresh}
          className="shrink-0 cursor-pointer underline hover:no-underline"
        >
          Retry
        </button>
      )}
      {!paused && (
        <button
          type="button"
          disabled={refreshDisabled}
          aria-label="Refresh mail"
          title="Refresh mail"
          onClick={onRefresh}
          className={restingControlClass}
        >
          <RefreshCw aria-hidden="true" size={ICON_SIZE.sm} />
        </button>
      )}
      <button
        type="button"
        aria-label={pauseLabel}
        title={pauseLabel}
        onClick={onTogglePaused}
        className={paused ? pausedControlClass : restingControlClass}
      >
        {paused ? (
          <Play aria-hidden="true" size={ICON_SIZE.sm} />
        ) : (
          <Pause aria-hidden="true" size={ICON_SIZE.sm} />
        )}
      </button>
    </>
  );
}

type LeftStatusView = {
  accountId: string | null;
  paused: boolean;
  reconnecting: boolean;
  failed: boolean;
  working: boolean;
  refreshing: boolean;
  label: string;
  title: string | undefined;
  traversal: TraversalStatus | null;
  indexing: boolean;
  index: { indexed: number; total: number };
};

function StatusLeftControls({
  view,
  onRefresh,
  onTogglePaused,
}: {
  view: LeftStatusView;
  onRefresh: () => void;
  onTogglePaused: () => void;
}) {
  const refreshDisabled = !view.accountId || view.refreshing || view.reconnecting;
  return (
    <div className="flex min-w-0 items-center gap-stack-gap-sm">
      <span className="flex size-4 shrink-0 items-center justify-center">
        {view.working ? (
          <Loader2 aria-hidden="true" size={ICON_SIZE.sm} className="motion-safe:animate-spin" />
        ) : (
          <span
            className={`size-chip-dot rounded-full ${statusDotClass(view.failed, view.paused)}`}
          />
        )}
      </span>
      <span
        role="status"
        aria-live="polite"
        className={`truncate ${view.failed ? 'text-error dark:text-dark-error' : ''}`}
        title={view.title}
      >
        {view.label}
      </span>
      <ActiveProgress
        traversal={view.traversal}
        indexing={view.indexing}
        reconnecting={view.reconnecting}
        index={view.index}
      />
      <StatusSyncButtons
        failed={view.failed}
        paused={view.paused}
        refreshDisabled={refreshDisabled}
        onRefresh={onRefresh}
        onTogglePaused={onTogglePaused}
      />
    </div>
  );
}

function useActiveIndexTotals() {
  const { data: indexStatuses = [] } = useAiIndexStatusesQuery();
  const activeIndexes = indexStatuses.filter(
    (status) => status.state === 'preparing' || status.state === 'building',
  );
  const totals = activeIndexes.reduce(
    (sum, status) => ({
      indexed: sum.indexed + status.indexed,
      total: sum.total + status.total,
    }),
    { indexed: 0, total: 0 },
  );
  return { indexing: activeIndexes.length > 0, totals: totals };
}

function useStatusBarState(accountId: string | null) {
  const { queue, lastSynced, syncState, error, refreshing } = useSyncStore();
  const now = useNow(LAST_SYNCED_REFRESH_MS);
  const traversal = activeTraversal(useTraversalStatusQuery(accountId).data);
  const { data: aiConfigs = [] } = useAiConfigsQuery();
  const aiConfig = aiConfigs.find((config) => config.accountId === accountId);
  const { indexing, totals: index } = useActiveIndexTotals();

  useEffect(() => {
    void useSyncStore.getState().hydrate();
    if (accountId) void useSyncStore.getState().hydrateSync(accountId);
  }, [accountId]);

  const paused = queue.paused;
  const flags = deriveSyncFlags({
    paused: paused,
    suspended: queue.suspended,
    syncState: syncState,
    traversal: traversal,
    indexing: indexing,
    refreshing: refreshing,
  });
  const label = statusLabel({
    paused: paused,
    reconnecting: flags.reconnecting,
    traversal: traversal,
    indexing: indexing,
    refreshing: refreshing,
    failed: flags.failed,
    pendingCount: queue.pending,
    lastSynced: lastSynced,
    now: now,
  });

  return {
    queue: queue,
    aiConfig: aiConfig,
    paused: paused,
    leftView: {
      accountId: accountId,
      paused: paused,
      reconnecting: flags.reconnecting,
      failed: flags.failed,
      working: flags.working,
      refreshing: refreshing,
      label: label,
      title: statusTitle(flags.failed, error, lastSynced),
      traversal: traversal,
      indexing: indexing,
      index: index,
    },
  };
}

export function StatusBar({ accountId = null }: { accountId?: string | null }) {
  const setRoute = useLayoutStore((layout) => layout.setRoute);
  const setActiveSection = useSettingsUiStore((settingsUi) => settingsUi.setActiveSection);
  const { queue, aiConfig, paused, leftView } = useStatusBarState(accountId);

  const refresh = () => {
    if (accountId) void useSyncStore.getState().triggerSync(accountId);
  };
  const togglePaused = () => {
    const command = paused ? 'resume_queue' : 'pause_queue';
    void invoke(command, {}).then((summary) => useSyncStore.getState().setQueue(summary));
  };
  const openSection = (section: 'ai' | 'queue') => {
    setActiveSection(section);
    setRoute('settings');
  };

  return (
    <footer data-testid="status-bar" className={paused ? pausedBarClass : restingBarClass}>
      <StatusLeftControls view={leftView} onRefresh={refresh} onTogglePaused={togglePaused} />
      <StatusRightActions
        accountId={accountId}
        aiConfig={aiConfig}
        paused={paused}
        pending={queue.pending}
        failed={queue.failed}
        onOpenSection={openSection}
      />
    </footer>
  );
}
