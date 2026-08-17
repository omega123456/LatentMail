import type { ReactNode } from 'react';
import { Loader2 } from 'lucide-react';

type EmptyStateProps = {
  children: ReactNode;
  variant?: 'plain' | 'syncing';
  persistedCount?: number;
  discoveredCount?: number;
};

export function EmptyState({
  children,
  variant = 'plain',
  persistedCount,
  discoveredCount,
}: EmptyStateProps) {
  if (variant === 'syncing')
    return (
      <div
        data-testid="empty-state-syncing"
        className="flex flex-col items-center gap-stack-gap-sm p-container-padding text-center text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant"
      >
        <Loader2
          aria-hidden="true"
          size={24}
          className="animate-spin text-primary dark:text-dark-primary"
        />
        <p>{children}</p>
        {persistedCount !== undefined && discoveredCount !== undefined && (
          <p className="tabular-nums text-label-sm">
            {persistedCount.toLocaleString()} of {discoveredCount.toLocaleString()} so far
          </p>
        )}
      </div>
    );
  return (
    <div className="p-container-padding text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
      {children}
    </div>
  );
}
