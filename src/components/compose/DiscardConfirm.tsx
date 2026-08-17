const pillButton = 'shrink-0 cursor-pointer rounded-full px-2.5 py-1 text-label-md font-bold';

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
      className="flex shrink-0 items-center gap-stack-gap-sm border-b border-outline-variant bg-error-container px-3 py-2 text-snippet text-on-error-container dark:border-dark-outline-variant dark:bg-dark-error-container dark:text-dark-on-error-container"
    >
      <p id="discard-title" className="min-w-0 flex-1 truncate">
        Discard this message?
      </p>
      <button type="button" onClick={onCancel} className={pillButton}>
        Keep
      </button>
      <button
        type="button"
        onClick={onDiscard}
        className={`${pillButton} bg-error text-on-error dark:bg-dark-error dark:text-dark-on-error`}
      >
        Discard
      </button>
    </div>
  );
}
