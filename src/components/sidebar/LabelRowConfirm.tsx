export type LabelRowConfirmProps = {
  labelName: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/** Inline, hand-rolled delete confirmation (the plan's one deliberate
 * exception to "use radix for every menu/context-menu/popover" — a plain
 * two-button row needs none of that machinery). */
export function LabelRowConfirm({ labelName, onConfirm, onCancel }: LabelRowConfirmProps) {
  return (
    <div
      role="alertdialog"
      aria-label={`Remove ${labelName}?`}
      className="flex items-center justify-between gap-2 rounded-md border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
    >
      <span className="text-body-sm text-on-surface dark:text-dark-on-surface">
        Remove &apos;{labelName}&apos;?
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="rounded bg-error px-2 py-1 text-label-md text-on-error focus-visible:outline-2 focus-visible:outline-error dark:bg-dark-error dark:text-dark-on-error"
        >
          Yes
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-2 py-1 text-label-md text-secondary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container"
        >
          No
        </button>
      </div>
    </div>
  );
}
