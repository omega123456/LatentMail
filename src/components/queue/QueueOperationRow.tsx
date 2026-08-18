import { useState } from 'react';
import { fromUnixTime, formatDistanceToNowStrict } from 'date-fns';
import { RotateCcw, X } from 'lucide-react';
import type { OperationRecord } from '@/lib/types/ipc';
import { OPERATION_STATUS_META } from '@/lib/queue/describe';
import { QueueStateChip } from './QueueStateChip';

const CANCELLABLE_STATUSES = new Set(['queued', 'retrying']);

function describeTiming(operation: OperationRecord) {
  if (operation.status === 'retrying' && operation.nextAttemptAt !== null) {
    return `Attempt ${operation.attempts} · next in ${formatDistanceToNowStrict(fromUnixTime(operation.nextAttemptAt))}`;
  }
  if (operation.status === 'active') {
    return `started ${formatDistanceToNowStrict(fromUnixTime(operation.updatedAt))} ago`;
  }
  return `${formatDistanceToNowStrict(fromUnixTime(operation.updatedAt))} ago`;
}

export function QueueOperationRow({
  operation,
  onCancel,
  onRetry,
}: {
  operation: OperationRecord;
  onCancel: (operationId: string) => Promise<boolean>;
  onRetry: (operationId: string) => void;
}) {
  const [cancelArrivedTooLate, setCancelArrivedTooLate] = useState(false);
  const statusMeta = OPERATION_STATUS_META[operation.status];
  const canCancel = CANCELLABLE_STATUSES.has(operation.status);
  const canRetry = operation.status === 'failed' && operation.retryable;
  const errorLine = cancelArrivedTooLate
    ? 'Already running — couldn’t cancel.'
    : operation.status === 'failed'
      ? operation.error
      : null;

  const handleCancel = async () => {
    setCancelArrivedTooLate(false);
    const applied = await onCancel(operation.id);
    if (!applied) setCancelArrivedTooLate(true);
  };

  return (
    <div data-testid={`queue-operation-${operation.id}`}>
      <div className="group flex h-queue-op-h items-center gap-3.5 pl-queue-indent-op pr-3.5 hover:bg-settings-container-low dark:hover:bg-dark-settings-container-low">
        <QueueStateChip
          pipClassName={statusMeta.pipClass}
          label={statusMeta.label}
          className={`w-29.5 ${statusMeta.chipClass}`}
        />
        <p className="min-w-0 flex-1 truncate text-body-sm text-settings-ink dark:text-dark-settings-ink">
          {operation.description}
        </p>
        <span className="w-33 shrink-0 whitespace-nowrap text-right text-settings-meta tabular-nums text-settings-ink-mute dark:text-dark-settings-ink-mute">
          {describeTiming(operation)}
        </span>
        <span className="flex w-10 shrink-0 justify-end opacity-0 focus-within:opacity-100 group-hover:opacity-100">
          {canCancel && (
            <button
              type="button"
              aria-label={`Cancel ${operation.description}`}
              onClick={() => void handleCancel()}
              className="grid size-6 cursor-pointer place-items-center rounded-chip text-settings-ink-mute hover:bg-settings-container hover:text-settings-error focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container dark:hover:text-dark-settings-error"
            >
              <X aria-hidden="true" size={13} />
            </button>
          )}
          {canRetry && (
            <button
              type="button"
              aria-label={`Retry ${operation.description}`}
              onClick={() => onRetry(operation.id)}
              className="grid size-6 cursor-pointer place-items-center rounded-chip text-settings-ink-mute hover:bg-settings-container hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container dark:hover:text-dark-settings-ink"
            >
              <RotateCcw aria-hidden="true" size={13} />
            </button>
          )}
        </span>
      </div>
      {errorLine && (
        <p
          role="alert"
          className="pb-1.75 pl-queue-indent-error pr-3.5 text-settings-meta text-settings-error dark:text-dark-settings-error"
        >
          {errorLine}
        </p>
      )}
    </div>
  );
}
