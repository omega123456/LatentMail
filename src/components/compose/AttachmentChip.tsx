import { AlertCircle, Loader2, X, type LucideIcon } from 'lucide-react';
import { createElement, type ReactNode } from 'react';
import type { ComposeAttachment } from '@/stores/compose';
import { formatFileSize } from '@/lib/format/file-size';
import { resolveMimeIcon } from '@/lib/format/mime-icon';
import { ICON_SIZE } from '@/components/shared/icon-size';

const ERROR_WELL_CLASS =
  'bg-error-container text-on-error-container dark:bg-dark-error-container dark:text-dark-on-error-container';
const NEUTRAL_WELL_CLASS =
  'bg-surface-container-high text-on-surface-variant dark:bg-dark-surface-container-high dark:text-dark-on-surface-variant';

function wellClass(
  failed: boolean,
  coloured: boolean,
  wellClassName: string,
  inkClassName: string,
): string {
  if (failed) return ERROR_WELL_CLASS;
  if (coloured) return `${wellClassName} ${inkClassName}`;
  return NEUTRAL_WELL_CLASS;
}

function wellGlyph(state: ComposeAttachment['state'], Icon: LucideIcon): ReactNode {
  if (state === 'reading') return <Loader2 className="animate-spin" size={ICON_SIZE.base} />;
  if (state === 'failed') return <AlertCircle size={ICON_SIZE.base} />;
  return createElement(Icon, { size: ICON_SIZE.base });
}

function attachmentSubtitle(attachment: ComposeAttachment): string {
  if (attachment.state === 'reading') return 'Reading…';
  if (attachment.state === 'failed') return attachment.error ?? "Couldn't read";
  return formatFileSize(attachment.size);
}

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
        className={`grid size-7 shrink-0 place-items-center rounded ${wellClass(failed, coloured, wellClassName, inkClassName)}`}
      >
        {wellGlyph(attachment.state, Icon)}
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
          {attachmentSubtitle(attachment)}
        </p>
      </div>
      <button
        type="button"
        aria-label={reading ? `Cancel ${attachment.filename}` : `Remove ${attachment.filename}`}
        title={reading ? 'Cancel' : 'Remove'}
        onClick={onRemove}
        className="shrink-0 cursor-pointer rounded p-1 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface"
      >
        <X aria-hidden="true" size={ICON_SIZE.sm} />
      </button>
    </div>
  );
}
