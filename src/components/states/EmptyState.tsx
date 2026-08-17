import type { ReactNode } from 'react';
import { Loader2, SearchX } from 'lucide-react';

type EmptyStateProps = {
  children?: ReactNode;
  variant?: 'plain' | 'syncing' | 'search';
  persistedCount?: number;
  discoveredCount?: number;
  query?: string;
};

export function EmptyState({
  children,
  variant = 'plain',
  persistedCount,
  discoveredCount,
  query = '',
}: EmptyStateProps) {
  if (variant === 'search')
    return (
      <div
        data-testid="empty-state-search"
        className="flex flex-col items-center gap-stack-gap-sm p-container-padding text-center text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant"
      >
        <SearchX aria-hidden="true" size={24} className="text-on-surface-variant dark:text-dark-on-surface-variant" />
        <p className="text-body-md text-on-surface dark:text-dark-on-surface">
          No results for &ldquo;{query}&rdquo;
        </p>
        <p>Try fewer words, check the spelling, or widen Search in to include Trash and Spam.</p>
      </div>
    );
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
