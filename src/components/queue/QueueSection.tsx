import { useMemo } from 'react';
import { History, Pause, Play, RotateCcw } from 'lucide-react';
import {
  useAccountsQuery,
  useCancelQueueOperationMutation,
  useClearQueueHistoryMutation,
  useQueueOperationsQuery,
  useRetryFailedOperationsMutation,
  useRetryQueueOperationMutation,
  useSetQueuePausedMutation,
} from '@/lib/query/hooks';
import { useSyncStore } from '@/stores/sync';
import { hasRetryableFailure } from '@/lib/queue/describe';
import type { Lane } from '@/lib/types/ipc';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { settingsButton, settingsQuietButton } from '@/components/settings/styles';
import { QueueAccountCard } from './QueueAccountCard';

export function QueueSection() {
  const { data: accounts } = useAccountsQuery();
  const { data: snapshots, isLoading, isError } = useQueueOperationsQuery();
  const globalPaused = useSyncStore((state) => state.queue.paused);

  const cancelOperation = useCancelQueueOperationMutation();
  const retryOperation = useRetryQueueOperationMutation();
  const retryFailed = useRetryFailedOperationsMutation();
  const clearHistory = useClearQueueHistoryMutation();
  const setPaused = useSetQueuePausedMutation();

  const accountById = useMemo(
    () => new Map((accounts ?? []).map((account) => [account.id, account])),
    [accounts],
  );

  const canRetryAllFailed = hasRetryableFailure(snapshots ?? []);

  const handleTogglePause = (accountId: string, lane: Lane | undefined, paused: boolean) => {
    setPaused.mutate({
      scope: lane ? { scope: 'lane', accountId, lane } : { scope: 'account', accountId },
      paused,
    });
  };

  return (
    <SettingsSection
      title="Queue"
      description="Mail operations waiting on Gmail, by account and lane."
      actions={
        <div className="flex items-center gap-2">
          {canRetryAllFailed && (
            <button
              type="button"
              onClick={() => retryFailed.mutate(undefined)}
              className={settingsQuietButton}
            >
              <RotateCcw aria-hidden="true" size={15} />
              Retry all failed
            </button>
          )}
          <button
            type="button"
            onClick={() => clearHistory.mutate(undefined)}
            className={settingsQuietButton}
          >
            <History aria-hidden="true" size={15} />
            Clear history
          </button>
          <button
            type="button"
            aria-label={globalPaused ? 'Resume all queued work' : 'Pause all queued work'}
            onClick={() => setPaused.mutate({ scope: { scope: 'global' }, paused: !globalPaused })}
            className={settingsButton}
          >
            {globalPaused ? (
              <Play aria-hidden="true" size={15} />
            ) : (
              <Pause aria-hidden="true" size={15} />
            )}
            {globalPaused ? 'Resume all' : 'Pause all'}
          </button>
        </div>
      }
    >
      {isLoading && (
        <p className="text-body-sm text-settings-ink-mute dark:text-dark-settings-ink-mute">
          Loading queue…
        </p>
      )}
      {isError && (
        <p role="alert" className="text-body-sm text-settings-error dark:text-dark-settings-error">
          Couldn&apos;t load the queue.
        </p>
      )}
      {!isLoading && !isError && snapshots?.length === 0 && (
        <p className="text-body-sm text-settings-ink-mute dark:text-dark-settings-ink-mute">
          No accounts are queuing mail operations.
        </p>
      )}
      {!isLoading && !isError && snapshots && snapshots.length > 0 && (
        <div className="flex flex-col gap-3.5">
          {snapshots.map((snapshot) => (
            <QueueAccountCard
              key={snapshot.accountId}
              account={accountById.get(snapshot.accountId)}
              snapshot={snapshot}
              onTogglePause={handleTogglePause}
              onCancelOperation={(id) => cancelOperation.mutateAsync(id)}
              onRetryOperation={(id) => retryOperation.mutate(id)}
            />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}
