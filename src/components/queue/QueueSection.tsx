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
import type { Account, AccountQueueSnapshot, Lane } from '@/lib/types/ipc';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { settingsButton, settingsQuietButton } from '@/components/settings/styles';
import { QueueAccountCard } from './QueueAccountCard';
import { ICON_SIZE } from '@/components/shared/icon-size';

function QueueSectionActions({
  canRetryAllFailed,
  globalPaused,
  onRetryAllFailed,
  onClearHistory,
  onToggleGlobalPause,
}: {
  canRetryAllFailed: boolean;
  globalPaused: boolean;
  onRetryAllFailed: () => void;
  onClearHistory: () => void;
  onToggleGlobalPause: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {canRetryAllFailed && (
        <button type="button" onClick={onRetryAllFailed} className={settingsQuietButton}>
          <RotateCcw aria-hidden="true" size={ICON_SIZE.md} />
          Retry all failed
        </button>
      )}
      <button type="button" onClick={onClearHistory} className={settingsQuietButton}>
        <History aria-hidden="true" size={ICON_SIZE.md} />
        Clear history
      </button>
      <button
        type="button"
        aria-label={globalPaused ? 'Resume all queued work' : 'Pause all queued work'}
        onClick={onToggleGlobalPause}
        className={settingsButton}
      >
        {globalPaused ? (
          <Play aria-hidden="true" size={ICON_SIZE.md} />
        ) : (
          <Pause aria-hidden="true" size={ICON_SIZE.md} />
        )}
        {globalPaused ? 'Resume all' : 'Pause all'}
      </button>
    </div>
  );
}

function QueueSectionBody({
  isLoading,
  isError,
  snapshots,
  accountById,
  onTogglePause,
  onCancelOperation,
  onRetryOperation,
}: {
  isLoading: boolean;
  isError: boolean;
  snapshots: AccountQueueSnapshot[] | undefined;
  accountById: Map<string, Account>;
  onTogglePause: (accountId: string, lane: Lane | undefined, paused: boolean) => void;
  onCancelOperation: (operationId: string) => Promise<boolean>;
  onRetryOperation: (operationId: string) => void;
}) {
  if (isLoading) {
    return (
      <p className="text-body-sm text-settings-ink-mute dark:text-dark-settings-ink-mute">
        Loading queue…
      </p>
    );
  }
  if (isError) {
    return (
      <p role="alert" className="text-body-sm text-settings-error dark:text-dark-settings-error">
        Couldn&apos;t load the queue.
      </p>
    );
  }
  if (!snapshots || snapshots.length === 0) {
    return (
      <p className="text-body-sm text-settings-ink-mute dark:text-dark-settings-ink-mute">
        No accounts are queuing mail operations.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-3.5">
      {snapshots.map((snapshot) => (
        <QueueAccountCard
          key={snapshot.accountId}
          account={accountById.get(snapshot.accountId)}
          snapshot={snapshot}
          onTogglePause={onTogglePause}
          onCancelOperation={onCancelOperation}
          onRetryOperation={onRetryOperation}
        />
      ))}
    </div>
  );
}

export function QueueSection() {
  const { data: accounts } = useAccountsQuery();
  const { data: snapshots, isLoading, isError } = useQueueOperationsQuery();
  const globalPaused = useSyncStore((sync) => sync.queue.paused);

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
      scope: lane
        ? { scope: 'lane', accountId: accountId, lane: lane }
        : { scope: 'account', accountId: accountId },
      paused: paused,
    });
  };

  return (
    <SettingsSection
      title="Queue"
      description="Mail operations waiting on Gmail, by account and lane."
      actions={
        <QueueSectionActions
          canRetryAllFailed={canRetryAllFailed}
          globalPaused={globalPaused}
          onRetryAllFailed={() => retryFailed.mutate(undefined)}
          onClearHistory={() => clearHistory.mutate(undefined)}
          onToggleGlobalPause={() =>
            setPaused.mutate({ scope: { scope: 'global' }, paused: !globalPaused })
          }
        />
      }
    >
      <QueueSectionBody
        isLoading={isLoading}
        isError={isError}
        snapshots={snapshots}
        accountById={accountById}
        onTogglePause={handleTogglePause}
        onCancelOperation={(id) => cancelOperation.mutateAsync(id)}
        onRetryOperation={(id) => retryOperation.mutate(id)}
      />
    </SettingsSection>
  );
}
