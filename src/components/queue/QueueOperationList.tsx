import type { OperationRecord } from '@/lib/types/ipc';
import { QueueOperationRow } from './QueueOperationRow';

export function QueueOperationList({
  operations,
  onCancel,
  onRetry,
}: {
  operations: OperationRecord[];
  onCancel: (operationId: string) => Promise<boolean>;
  onRetry: (operationId: string) => void;
}) {
  if (operations.length === 0) {
    return (
      <p className="py-1.75 pl-queue-indent-op text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
        No operations waiting in this lane.
      </p>
    );
  }
  return (
    <div className="flex flex-col">
      {operations.map((operation) => (
        <QueueOperationRow
          key={operation.id}
          operation={operation}
          onCancel={onCancel}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}
