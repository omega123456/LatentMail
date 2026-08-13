export function DiscardConfirm({
  onCancel,
  onDiscard,
}: {
  onCancel: () => void;
  onDiscard: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby="discard-title"
      className="mx-stack-gap-md mb-stack-gap-sm rounded-md border border-outline-variant bg-surface-container-low p-stack-gap-md dark:border-dark-outline-variant dark:bg-dark-surface-container-low"
    >
      <p id="discard-title" className="text-body-md text-on-surface dark:text-dark-on-surface">
        Discard this draft?
      </p>
      <div className="mt-stack-gap-sm flex justify-end gap-stack-gap-sm">
        <button
          type="button"
          onClick={onCancel}
          className="rounded px-stack-gap-sm py-1 text-label-md text-secondary dark:text-dark-secondary"
        >
          Keep editing
        </button>
        <button
          type="button"
          onClick={onDiscard}
          className="rounded bg-error px-stack-gap-sm py-1 text-label-md text-on-error dark:bg-dark-error dark:text-dark-on-error"
        >
          Discard
        </button>
      </div>
    </div>
  );
}
