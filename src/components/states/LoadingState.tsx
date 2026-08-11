import type { ReactNode } from 'react';

export function LoadingState({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <div className="p-container-padding text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
      {children}
    </div>
  );
}
