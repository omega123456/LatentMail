import { useState } from 'react';
import {
  useCancelAiIndexMutation,
  useRebuildAiIndexMutation,
  useStartAiIndexMutation,
} from '@/lib/query/hooks';
import type { AiIndexStatus } from '@/lib/types/ipc';
import { AiStatusCard, type AiStatusPip } from './AiStatusCard';
import { InlineConfirm } from './InlineConfirm';
import { SettingRow } from './SettingRow';
import { SettingsSubsection } from './SettingsSection';
import { settingsQuietButton } from './styles';
import { percentOf } from '@/lib/format/percent';

type State = AiIndexStatus['state'];

const labels: Record<State, string> = {
  notStarted: 'Not started',
  preparing: 'Preparing index',
  building: 'Building',
  complete: 'Index complete',
  partial: 'Partial',
  paused: 'Paused',
  interrupted: 'Interrupted',
  unavailable: 'Unavailable',
  needsRebuild: 'Rebuild required',
};

const pips: Record<State, AiStatusPip> = {
  notStarted: 'idle',
  preparing: 'warn',
  building: 'warn',
  complete: 'success',
  partial: 'warn',
  paused: 'warn',
  interrupted: 'warn',
  unavailable: 'warn',
  needsRebuild: 'warn',
};

const REBUILD_MESSAGE =
  'This index was built with the previous distance measure. Rebuild it before asking questions about this account.';

const RESUMABLE: State[] = ['notStarted', 'partial', 'paused', 'interrupted', 'unavailable'];
const TRACKED: State[] = ['preparing', 'building', 'partial'];

function count(total: number) {
  return total.toLocaleString();
}

function IndexProgress({
  state,
  indexed,
  total,
  percentage,
}: {
  state: State;
  indexed: number;
  total: number;
  percentage: number;
}) {
  const preparing = state === 'preparing';
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-settings-desc font-semibold text-settings-ink dark:text-dark-settings-ink">
          <span
            aria-hidden="true"
            className="size-1.75 shrink-0 rounded-full bg-settings-amber dark:bg-dark-settings-amber"
          />
          {labels[state]}
        </span>
        {!preparing && (
          <span className="tabular-nums text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
            {count(indexed)} of {count(total)} · {percentage}%
          </span>
        )}
      </div>
      <div
        role="progressbar"
        aria-label="Index progress"
        aria-valuemin={preparing ? undefined : 0}
        aria-valuemax={preparing ? undefined : total}
        aria-valuenow={preparing ? undefined : indexed}
        aria-valuetext={
          preparing ? 'Preparing index' : `${count(indexed)} of ${count(total)} messages`
        }
        className="h-2 overflow-hidden rounded-full bg-settings-bar-idle dark:bg-dark-settings-bar-idle"
      >
        <div
          className={`h-full rounded-full bg-settings-bar dark:bg-dark-settings-bar ${preparing ? 'w-1/3 opacity-75 motion-safe:animate-pulse' : ''}`}
          style={preparing ? undefined : { width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}

function statusDetail(
  current: State,
  started: boolean,
  indexedMessages: number,
  indexedPassages: number,
): string {
  if (current === 'needsRebuild') return REBUILD_MESSAGE;
  if (started) return `${count(indexedMessages)} messages · ${count(indexedPassages)} passages`;
  return 'No indexed messages yet';
}

function RebuildSection({
  current,
  confirming,
  indexedPassages,
  onStartConfirm,
  onCancelConfirm,
  onRebuild,
}: {
  current: State;
  confirming: boolean;
  indexedPassages: number;
  onStartConfirm: () => void;
  onCancelConfirm: () => void;
  onRebuild: () => void;
}) {
  if (confirming) {
    return (
      <InlineConfirm
        icon="rebuild"
        title="Rebuild the whole index?"
        body={`All ${count(indexedPassages)} passages will be deleted and re-embedded from the start. This sends every message to your endpoint again.`}
        action="Rebuild"
        onCancel={onCancelConfirm}
        onConfirm={onRebuild}
      />
    );
  }
  if (current === 'preparing') return null;
  return (
    <div className="border-t border-settings-outline-variant dark:border-dark-settings-outline-variant">
      <SettingRow
        label="Rebuild index"
        description="Clears this account's vectors and starts it again."
      >
        <button
          type="button"
          onClick={onStartConfirm}
          className={`shrink-0 ${settingsQuietButton}`}
        >
          Rebuild
        </button>
      </SettingRow>
    </div>
  );
}

function IndexHeaderAction({
  current,
  resumable,
  started,
  cancelling,
  cancelPending,
  startPending,
  onCancel,
  onStart,
}: {
  current: State;
  resumable: boolean;
  started: boolean;
  cancelling: boolean;
  cancelPending: boolean;
  startPending: boolean;
  onCancel: () => void;
  onStart: () => void;
}) {
  if (current === 'building') {
    return (
      <button
        type="button"
        onClick={onCancel}
        disabled={cancelling || cancelPending}
        className={`shrink-0 ${settingsQuietButton} disabled:cursor-not-allowed disabled:opacity-50`}
      >
        {cancelling ? 'Cancelling…' : 'Cancel'}
      </button>
    );
  }
  if (!resumable) return null;
  return (
    <button
      type="button"
      onClick={onStart}
      disabled={startPending}
      className={`shrink-0 ${settingsQuietButton} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {started ? 'Resume' : 'Start'}
    </button>
  );
}

function readStatusMetrics(status: AiIndexStatus | undefined) {
  const current: State = status?.state ?? 'unavailable';
  const indexedMessages = status?.indexedMessages ?? 0;
  const totalEligibleMessages = status?.totalEligibleMessages ?? 0;
  const indexedPassages = status?.indexedPassages ?? 0;
  return {
    current: current,
    indexedMessages: indexedMessages,
    totalEligibleMessages: totalEligibleMessages,
    indexedPassages: indexedPassages,
    percentage: Math.round(percentOf(indexedMessages, totalEligibleMessages)),
    resumable: RESUMABLE.includes(current),
    started: current !== 'notStarted' && current !== 'unavailable',
  };
}

export function AiIndexSection({
  accountId,
  status,
}: {
  accountId: string;
  status: AiIndexStatus | undefined;
}) {
  const [cancelling, setCancelling] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const start = useStartAiIndexMutation();
  const cancel = useCancelAiIndexMutation();
  const rebuild = useRebuildAiIndexMutation();
  const metrics = readStatusMetrics(status);

  const rebuildAction =
    metrics.current === 'needsRebuild' && !confirming ? (
      <button
        type="button"
        onClick={() => setConfirming(true)}
        className={`shrink-0 ${settingsQuietButton}`}
      >
        Rebuild
      </button>
    ) : undefined;

  return (
    <SettingsSubsection
      title="Index"
      description="Indexing runs in the background queue and pauses when you pause the queue."
      action={
        <IndexHeaderAction
          current={metrics.current}
          resumable={metrics.resumable}
          started={metrics.started}
          cancelling={cancelling}
          cancelPending={cancel.isPending}
          startPending={start.isPending}
          onCancel={() => {
            setCancelling(true);
            cancel.mutate(accountId, { onSettled: () => setCancelling(false) });
          }}
          onStart={() => start.mutate(accountId)}
        />
      }
    >
      {status?.error && (
        <div role="alert">
          <AiStatusCard tone="error" pip="error" title="Indexing stopped" detail={status.error} />
        </div>
      )}
      <div aria-live="polite" className="flex flex-col gap-2.5">
        {TRACKED.includes(metrics.current) ? (
          <IndexProgress
            state={metrics.current}
            indexed={metrics.indexedMessages}
            total={metrics.totalEligibleMessages}
            percentage={metrics.percentage}
          />
        ) : (
          <AiStatusCard
            tone={metrics.current === 'complete' ? 'success' : 'neutral'}
            pip={pips[metrics.current]}
            title={labels[metrics.current]}
            detail={statusDetail(
              metrics.current,
              metrics.started,
              metrics.indexedMessages,
              metrics.indexedPassages,
            )}
            action={rebuildAction}
          />
        )}
      </div>
      <RebuildSection
        current={metrics.current}
        confirming={confirming}
        indexedPassages={metrics.indexedPassages}
        onStartConfirm={() => setConfirming(true)}
        onCancelConfirm={() => setConfirming(false)}
        onRebuild={() => rebuild.mutate(accountId, { onSuccess: () => setConfirming(false) })}
      />
    </SettingsSubsection>
  );
}
