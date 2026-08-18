import { AlertDialog } from 'radix-ui';
import type { Account } from '@/lib/types/ipc';

export function RemoveAccountDialog({
  account,
  onConfirm,
  onCancel,
  removing,
}: {
  account: Account;
  onConfirm: () => void;
  onCancel: () => void;
  removing: boolean;
}) {
  return (
    <AlertDialog.Root open onOpenChange={(open) => !open && onCancel()}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-inverse-surface/40 dark:bg-black/60" />
        <AlertDialog.Content className="fixed left-1/2 top-1/2 w-full max-w-md -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-container-lowest p-6 shadow-lg dark:bg-dark-surface-container-lowest">
          <AlertDialog.Title className="text-title-lg text-on-surface dark:text-dark-on-surface">
            Remove {account.email}?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-stack-gap-sm text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
            LatentMail will sign this account out and delete its cached mail, labels, contacts and
            drafts from this device. This can&apos;t be undone.
          </AlertDialog.Description>
          <div className="mt-stack-gap-md flex justify-end gap-stack-gap-sm">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                onClick={onCancel}
                className="cursor-pointer rounded px-3 py-2 text-label-md text-on-surface-variant hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                onClick={onConfirm}
                disabled={removing}
                className="cursor-pointer rounded bg-error px-3 py-2 text-label-md text-on-error disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-error dark:bg-dark-error dark:text-dark-on-error"
              >
                {removing ? 'Removing…' : 'Remove account'}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
