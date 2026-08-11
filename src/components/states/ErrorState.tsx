import type { ReactNode } from 'react';

export function ErrorState({ children }: { children: ReactNode }) {
  return (
    <div role="alert" className="p-container-padding text-body-sm text-error dark:text-dark-error">
      {children}
    </div>
  );
}
