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

function count(value: number) {
  return value.toLocaleString();
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
  const current = status?.state ?? 'unavailable';
  const indexedMessages = status?.indexedMessages ?? 0;
  const totalEligibleMessages = status?.totalEligibleMessages ?? 0;
  const indexedPassages = status?.indexedPassages ?? 0;
  const percentage =
    totalEligibleMessages === 0 ? 0 : Math.round((indexedMessages / totalEligibleMessages) * 100);
  const resumable = RESUMABLE.includes(current);
  const started = current !== 'notStarted' && current !== 'unavailable';

  const resume = resumable && (
    <button
      type="button"
      onClick={() => start.mutate(accountId)}
      disabled={start.isPending}
      className={`shrink-0 ${settingsQuietButton} disabled:cursor-not-allowed disabled:opacity-50`}
    >
      {started ? 'Resume' : 'Start'}
    </button>
  );

  return (
    <SettingsSubsection
      title="Index"
      description="Indexing runs in the background queue and pauses when you pause the queue."
      action={
        current === 'building' ? (
          <button
            type="button"
            onClick={() => {
              setCancelling(true);
              cancel.mutate(accountId, { onSettled: () => setCancelling(false) });
            }}
            disabled={cancelling || cancel.isPending}
            className={`shrink-0 ${settingsQuietButton} disabled:cursor-not-allowed disabled:opacity-50`}
          >
            {cancelling ? 'Cancelling…' : 'Cancel'}
          </button>
        ) : (
          resume
        )
      }
    >
      {status?.error && (
        <div role="alert">
          <AiStatusCard tone="error" pip="error" title="Indexing stopped" detail={status.error} />
        </div>
      )}
      <div aria-live="polite" className="flex flex-col gap-2.5">
        {TRACKED.includes(current) ? (
          <IndexProgress
            state={current}
            indexed={indexedMessages}
            total={totalEligibleMessages}
            percentage={percentage}
          />
        ) : (
          <AiStatusCard
            tone={current === 'complete' ? 'success' : 'neutral'}
            pip={pips[current]}
            title={labels[current]}
            detail={
              current === 'needsRebuild'
                ? REBUILD_MESSAGE
                : started
                  ? `${count(indexedMessages)} messages · ${count(indexedPassages)} passages`
                  : 'No indexed messages yet'
            }
            action={
              current === 'needsRebuild' && !confirming ? (
                <button
                  type="button"
                  onClick={() => setConfirming(true)}
                  className={`shrink-0 ${settingsQuietButton}`}
                >
                  Rebuild
                </button>
              ) : undefined
            }
          />
        )}
      </div>
      {confirming ? (
        <InlineConfirm
          icon="rebuild"
          title="Rebuild the whole index?"
          body={`All ${count(indexedPassages)} passages will be deleted and re-embedded from the start. This sends every message to your endpoint again.`}
          action="Rebuild"
          onCancel={() => setConfirming(false)}
          onConfirm={() => rebuild.mutate(accountId, { onSuccess: () => setConfirming(false) })}
        />
      ) : (
        current !== 'preparing' && (
          <div className="border-t border-settings-outline-variant dark:border-dark-settings-outline-variant">
            <SettingRow
              label="Rebuild index"
              description="Clears this account's vectors and starts it again."
            >
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className={`shrink-0 ${settingsQuietButton}`}
              >
                Rebuild
              </button>
            </SettingRow>
          </div>
        )
      )}
    </SettingsSubsection>
  );
}
