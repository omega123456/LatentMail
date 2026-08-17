import { Trash2, X } from 'lucide-react';
import { type ComposeMode, modeTitles } from '@/stores/compose';

const circularButton =
  'inline-flex size-8 cursor-pointer items-center justify-center rounded-full text-secondary focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary';

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
    <div className="flex shrink-0 items-center justify-between gap-2 border-b border-outline-variant bg-surface py-2 pl-stack-gap-md pr-2.5 dark:border-dark-outline-variant dark:bg-dark-surface">
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
          className={`${circularButton} hover:bg-surface-container-high hover:text-error disabled:cursor-not-allowed disabled:opacity-40 dark:hover:bg-dark-surface-container-high dark:hover:text-dark-error`}
        >
          <Trash2 aria-hidden="true" size={18} />
        </button>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className={`${circularButton} hover:bg-surface-container-high hover:text-primary dark:hover:bg-dark-surface-container-high dark:hover:text-dark-primary`}
        >
          <X aria-hidden="true" size={18} />
        </button>
      </div>
    </div>
  );
}
