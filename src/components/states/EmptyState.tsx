import type { ReactNode } from 'react';

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="p-container-padding text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
      {children}
    </div>
  );
}
