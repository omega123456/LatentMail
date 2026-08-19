import { AlertCircle, Loader2, X } from 'lucide-react';
import { createElement } from 'react';
import type { ComposeAttachment } from '@/stores/compose';
import { formatFileSize } from '@/lib/format/file-size';
import { resolveMimeIcon } from '@/lib/format/mime-icon';

export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposeAttachment;
  onRemove: () => void;
}) {
  const { Icon, coloured, inkClassName, wellClassName } = resolveMimeIcon(
    attachment.mimeType,
    attachment.filename,
  );
  const reading = attachment.state === 'reading';
  const failed = attachment.state === 'failed';
  return (
    <div
      data-testid={`attachment-chip-${attachment.localId}`}
      data-attachment-state={attachment.state}
      className="flex max-w-56 items-center gap-stack-gap-sm rounded border border-outline-variant bg-surface-container-low p-1.5 dark:border-dark-outline-variant dark:bg-dark-surface-container-low"
    >
      <div
        aria-hidden="true"
        className={`grid size-7 shrink-0 place-items-center rounded ${
          failed
            ? 'bg-error-container text-on-error-container dark:bg-dark-error-container dark:text-dark-on-error-container'
            : coloured
              ? `${wellClassName} ${inkClassName}`
              : 'bg-surface-container-high text-on-surface-variant dark:bg-dark-surface-container-high dark:text-dark-on-surface-variant'
        }`}
      >
        {reading ? (
          <Loader2 className="animate-spin" size={16} />
        ) : failed ? (
          <AlertCircle size={16} />
        ) : (
          createElement(Icon, { size: 16 })
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p
          title={attachment.filename}
          className="truncate text-snippet text-on-surface dark:text-dark-on-surface"
        >
          {attachment.filename}
        </p>
        <p
          className={`truncate text-label-sm ${
            failed ? 'text-error dark:text-dark-error' : 'text-outline dark:text-dark-outline'
          }`}
        >
          {reading
            ? 'Reading…'
            : failed
              ? (attachment.error ?? "Couldn't read")
              : formatFileSize(attachment.size)}
        </p>
      </div>
      <button
        type="button"
        aria-label={reading ? `Cancel ${attachment.filename}` : `Remove ${attachment.filename}`}
        title={reading ? 'Cancel' : 'Remove'}
        onClick={onRemove}
        className="shrink-0 cursor-pointer rounded p-1 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface"
      >
        <X aria-hidden="true" size={14} />
      </button>
    </div>
  );
}
