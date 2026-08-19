import { createElement, useState } from 'react';
import { AlertCircle, Download, Loader2 } from 'lucide-react';
import { sanitizeFilename } from '@/lib/attachments/filename';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc } from '@/lib/ipc/dispatch';
import { formatFileSize } from '@/lib/format/file-size';
import { resolveMimeIcon } from '@/lib/format/mime-icon';
import { useCachedAttachmentQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import type { MessageAttachment } from '@/lib/types/ipc';

type DownloadState = 'idle' | 'downloading' | 'failed';

export function ReceivedAttachmentChip({
  accountId,
  messageId,
  attachment,
  onPreview,
}: {
  accountId: string | null;
  messageId: string;
  attachment: MessageAttachment;
  onPreview: () => void;
}) {
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');
  const prefetch = useLayoutStore((state) => state.prefetchImageAttachments);
  const { family, Icon, coloured, inkClassName, wellClassName } = resolveMimeIcon(
    attachment.mimeType,
    attachment.filename,
  );
  const wantsThumbnail = prefetch && family === 'image';
  const cachedQuery = useCachedAttachmentQuery(accountId, messageId, attachment.id, wantsThumbnail);
  const showThumbnail = wantsThumbnail && cachedQuery.isSuccess;
  const thumbnailLoading = wantsThumbnail && cachedQuery.isPending;
  const downloading = downloadState === 'downloading';
  const failed = downloadState === 'failed';

  const download = async () => {
    if (!accountId || downloading) return;
    const destination = await invoke('plugin:dialog|save', {
      options: { defaultPath: sanitizeFilename(attachment.filename) },
    });
    if (!destination) return;
    setDownloadState('downloading');
    try {
      await invoke('save_attachment_to_path', {
        accountId,
        messageId,
        attachmentId: attachment.id,
        destination,
      });
      setDownloadState('idle');
    } catch {
      setDownloadState('failed');
    }
  };

  return (
    <div
      data-testid={`received-attachment-chip-${attachment.id}`}
      className={`relative flex max-w-56 items-center gap-stack-gap-sm rounded-chip border border-outline-variant bg-surface-container-low p-1.5 shadow-segment dark:border-dark-outline-variant dark:bg-dark-surface-container-low dark:shadow-none ${downloading ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        aria-label={`Preview ${attachment.filename}`}
        onClick={onPreview}
        className="absolute inset-0 rounded-chip focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      />
      <div
        aria-hidden="true"
        className={`relative size-7 shrink-0 overflow-hidden rounded-chip ${
          failed
            ? 'bg-error-container text-on-error-container dark:bg-dark-error-container dark:text-dark-on-error-container'
            : coloured && !downloading
              ? `${wellClassName} ${inkClassName}`
              : 'bg-surface-container-high text-on-surface-variant dark:bg-dark-surface-container-high dark:text-dark-on-surface-variant'
        } grid place-items-center ${thumbnailLoading ? 'animate-pulse' : ''}`}
      >
        {downloading ? (
          <Loader2 className="animate-spin" size={16} />
        ) : failed ? (
          <AlertCircle size={16} />
        ) : showThumbnail && cachedQuery.data ? (
          <img
            data-testid="attachment-thumbnail"
            src={dispatchConvertFileSrc(cachedQuery.data.displayPath)}
            alt=""
            className="size-full object-cover"
          />
        ) : thumbnailLoading ? null : (
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
          {downloading
            ? 'Downloading…'
            : failed
              ? "Couldn't download"
              : formatFileSize(attachment.size)}
        </p>
      </div>
      <button
        type="button"
        aria-label={
          downloading
            ? `Downloading ${attachment.filename}`
            : failed
              ? `Retry download of ${attachment.filename}`
              : `Download ${attachment.filename}`
        }
        disabled={downloading}
        onClick={() => void download()}
        className="relative z-10 shrink-0 cursor-pointer rounded-chip p-1 text-secondary hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:cursor-not-allowed dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface"
      >
        {downloading ? (
          <Loader2 className="animate-spin" size={14} aria-hidden="true" />
        ) : (
          <Download size={14} aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
