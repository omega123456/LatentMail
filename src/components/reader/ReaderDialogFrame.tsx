import type { ReactNode } from 'react';
import { Dialog } from 'radix-ui';
import { X } from 'lucide-react';

export const dialogPrimaryButtonClass =
  'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-chip bg-primary px-3 py-1.5 text-label-md font-semibold text-on-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary dark:bg-dark-primary dark:text-dark-on-primary';

export const dialogQuietButtonClass =
  'flex shrink-0 cursor-pointer items-center gap-1.5 rounded-chip bg-surface-container px-3 py-1.5 text-label-md font-semibold text-on-surface hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary dark:bg-dark-surface-container dark:text-dark-on-surface dark:hover:bg-dark-surface-container-high';

function portalTarget(): HTMLElement | undefined {
  return document.getElementById('root') ?? undefined;
}

export function ReaderDialogFrame({
  title,
  testId,
  closeLabel,
  actions,
  onClose,
  children,
}: {
  title: string;
  testId: string;
  closeLabel: string;
  actions: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal container={portalTarget()}>
        <Dialog.Overlay className="absolute inset-0 z-40 bg-inverse-surface/40 dark:bg-black/60" />
        <Dialog.Content
          onClick={(event) => event.target === event.currentTarget && onClose()}
          className="absolute inset-0 z-50 grid place-items-center p-4 outline-none"
        >
          <div
            data-testid={testId}
            className="flex h-11/12 max-h-preview-modal-h w-11/12 max-w-preview-modal-w flex-col overflow-hidden rounded-card bg-surface-container-lowest shadow-lg dark:bg-dark-surface-container-lowest"
          >
            <div className="flex items-center gap-stack-gap-sm border-b border-outline-variant p-3 dark:border-dark-outline-variant">
              <Dialog.Title
                title={title}
                className="min-w-0 flex-1 truncate text-title-lg text-on-surface dark:text-dark-on-surface"
              >
                {title}
              </Dialog.Title>
              {actions}
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label={closeLabel}
                  className="shrink-0 cursor-pointer rounded-chip p-1.5 text-secondary hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">{children}</div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ReaderDialogStatus({ children }: { children: ReactNode }) {
  return (
    <div className="grid h-full place-items-center p-stack-gap-md text-center text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
      <div className="flex flex-col items-center gap-stack-gap-sm">{children}</div>
    </div>
  );
}
