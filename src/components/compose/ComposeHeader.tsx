import { Trash2, X } from 'lucide-react';
import { type ComposeMode, modeTitles } from '@/stores/compose';

const circularButton =
  'inline-flex size-8 items-center justify-center rounded-full text-secondary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary';

/** The mode title also doubles as the dialog's accessible name — the
 * caller (`ComposeOverlay`) wires `titleId` to `Dialog.Content`'s
 * `aria-labelledby` rather than this rendering `Dialog.Title` directly, so
 * the header stays a plain, independently testable component instead of
 * one that throws outside a `Dialog.Root`. */
export function ComposeHeader({
  mode,
  titleId,
  onClose,
  onDiscard,
}: {
  mode: ComposeMode;
  titleId?: string;
  onClose: () => void;
  onDiscard?: () => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between rounded-t-lg border-b border-outline-variant bg-surface px-stack-gap-md py-stack-gap-sm dark:border-dark-outline-variant dark:bg-dark-surface">
      <h2 id={titleId} className="text-title-lg text-on-surface dark:text-dark-on-surface">
        {modeTitles[mode]}
      </h2>
      <div className="flex items-center gap-1">
        <button
          type="button"
          aria-label="Discard"
          title="Discard"
          disabled={!onDiscard}
          onClick={onDiscard}
          className={`${circularButton} hover:text-error disabled:cursor-not-allowed disabled:opacity-40 dark:hover:text-dark-error`}
        >
          <Trash2 aria-hidden="true" size={18} />
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className={`${circularButton} hover:bg-surface-container-low hover:text-primary dark:hover:bg-dark-surface-container-low dark:hover:text-dark-primary`}
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
    </div>
  );
}
