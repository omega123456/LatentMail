import {
  AlertCircle,
  File,
  FileArchive,
  FileAudio,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Loader2,
  X,
} from 'lucide-react';
import { createElement, type ComponentType } from 'react';
import type { ComposeAttachment } from '@/stores/compose';

/** Category icon lookup, exactly the set the wireframe names — a fallback
 * (`File`) covers everything else rather than growing this list per
 * extension. No thumbnails are ever rendered (FR "Attachments and inline
 * images"), so this icon is the chip's only visual identifier. */
const categoryIcons: {
  test: (mimeType: string) => boolean;
  Icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean | 'true' | 'false' }>;
}[] = [
  { test: (mime) => mime.startsWith('image/'), Icon: ImageIcon },
  { test: (mime) => mime.startsWith('video/'), Icon: FileVideo },
  { test: (mime) => mime.startsWith('audio/'), Icon: FileAudio },
  {
    test: (mime) => mime.includes('zip') || mime.includes('compressed') || mime.includes('archive'),
    Icon: FileArchive,
  },
  {
    test: (mime) => mime.includes('spreadsheet') || mime.includes('excel') || mime === 'text/csv',
    Icon: FileSpreadsheet,
  },
  {
    test: (mime) =>
      mime.startsWith('text/') ||
      mime.includes('pdf') ||
      mime.includes('document') ||
      mime.includes('word'),
    Icon: FileText,
  },
];

function iconFor(mimeType: string) {
  return categoryIcons.find((entry) => entry.test(mimeType))?.Icon ?? File;
}

/** `1_048_576 → '1 MB'`, matching the wireframe's short-unit style. Binary
 * (1024-based) units, since that's what the filesystem byte counts Rust
 * hands back actually mean. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unitIndex]}`;
}

/** One attachment chip in the composer's `AttachmentStrip` — settled,
 * reading (spinner swatch, cancellation instead of removal) or failed
 * (error-container swatch, message scoped to this chip, never a toast). No
 * thumbnails, ever (wireframe "Attachment chips — settled, reading,
 * failed"). */
export function AttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: ComposeAttachment;
  onRemove: () => void;
}) {
  const icon = iconFor(attachment.mimeType);
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
            : 'bg-surface-container-high text-on-surface-variant dark:bg-dark-surface-container-high dark:text-dark-on-surface-variant'
        }`}
      >
        {reading ? (
          <Loader2 className="animate-spin" size={16} />
        ) : failed ? (
          <AlertCircle size={16} />
        ) : (
          createElement(icon, { size: 16 })
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
              : formatSize(attachment.size)}
        </p>
      </div>
      <button
        type="button"
        aria-label={reading ? `Cancel ${attachment.filename}` : `Remove ${attachment.filename}`}
        title={reading ? 'Cancel' : 'Remove'}
        onClick={onRemove}
        className="shrink-0 rounded p-1 text-secondary hover:bg-surface-container-low hover:text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface"
      >
        <X aria-hidden="true" size={14} />
      </button>
    </div>
  );
}
