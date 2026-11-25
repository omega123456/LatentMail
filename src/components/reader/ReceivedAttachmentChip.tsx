import { createElement, useState, type ReactNode } from 'react';
import { AlertCircle, Download, Loader2, type LucideIcon } from 'lucide-react';
import { sanitizeFilename } from '@/lib/attachments/filename';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc } from '@/lib/ipc/dispatch';
import { formatFileSize } from '@/lib/format/file-size';
import { resolveMimeIcon } from '@/lib/format/mime-icon';
import { useCachedAttachmentQuery } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import type { MessageAttachment } from '@/lib/types/ipc';
import { ICON_SIZE } from '@/components/shared/icon-size';

type DownloadState = 'idle' | 'downloading' | 'failed';

const ERROR_WELL_CLASS =
  'bg-error-container text-on-error-container dark:bg-dark-error-container dark:text-dark-on-error-container';
const NEUTRAL_WELL_CLASS =
  'bg-surface-container-high text-on-surface-variant dark:bg-dark-surface-container-high dark:text-dark-on-surface-variant';

function chipWellClass({
  downloadState,
  coloured,
  wellClassName,
  inkClassName,
}: {
  downloadState: DownloadState;
  coloured: boolean;
  wellClassName: string;
  inkClassName: string;
}): string {
  if (downloadState === 'failed') return ERROR_WELL_CLASS;
  if (coloured && downloadState !== 'downloading') return `${wellClassName} ${inkClassName}`;
  return NEUTRAL_WELL_CLASS;
}

function renderWellContent(input: {
  downloadState: DownloadState;
  thumbnailPath: string | null;
  thumbnailLoading: boolean;
  Icon: LucideIcon;
}): ReactNode {
  if (input.downloadState === 'downloading') {
    return <Loader2 className="animate-spin" size={ICON_SIZE.base} />;
  }
  if (input.downloadState === 'failed') {
    return <AlertCircle size={ICON_SIZE.base} />;
  }
  if (input.thumbnailPath) {
    return (
      <img
        data-testid="attachment-thumbnail"
        src={dispatchConvertFileSrc(input.thumbnailPath)}
        alt=""
        className="size-full object-cover"
      />
    );
  }
  if (input.thumbnailLoading) return null;
  return createElement(input.Icon, { size: ICON_SIZE.base });
}

function downloadSubtitle(downloadState: DownloadState, size: number): string {
  if (downloadState === 'downloading') return 'Downloading…';
  if (downloadState === 'failed') return "Couldn't download";
  return formatFileSize(size);
}

const DOWNLOAD_ARIA_PREFIX: Record<DownloadState, string> = {
  downloading: 'Downloading',
  failed: 'Retry download of',
  idle: 'Download',
};

function useAttachmentDownload(input: {
  accountId: string | null;
  messageId: string;
  attachment: MessageAttachment;
}) {
  const [downloadState, setDownloadState] = useState<DownloadState>('idle');

  const download = async () => {
    if (!input.accountId || downloadState === 'downloading') return;
    const destination = await invoke('plugin:dialog|save', {
      options: { defaultPath: sanitizeFilename(input.attachment.filename) },
    });
    if (!destination) return;
    setDownloadState('downloading');
    try {
      await invoke('save_attachment_to_path', {
        accountId: input.accountId,
        messageId: input.messageId,
        attachmentId: input.attachment.id,
        destination: destination,
      });
      setDownloadState('idle');
    } catch {
      setDownloadState('failed');
    }
  };

  return { downloadState: downloadState, download: download };
}

function AttachmentDownloadButton({
  downloadState,
  filename,
  onDownload,
}: {
  downloadState: DownloadState;
  filename: string;
  onDownload: () => void;
}) {
  const downloading = downloadState === 'downloading';
  return (
    <button
      type="button"
      aria-label={`${DOWNLOAD_ARIA_PREFIX[downloadState]} ${filename}`}
      disabled={downloading}
      onClick={onDownload}
      className="relative z-10 shrink-0 cursor-pointer rounded-chip p-1 text-secondary hover:bg-surface-container hover:text-on-surface focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary disabled:cursor-not-allowed dark:text-dark-secondary dark:hover:bg-dark-surface-container dark:hover:text-dark-on-surface"
    >
      {downloading ? (
        <Loader2 className="animate-spin" size={ICON_SIZE.sm} aria-hidden="true" />
      ) : (
        <Download size={ICON_SIZE.sm} aria-hidden="true" />
      )}
    </button>
  );
}

function AttachmentThumbnailWell({
  accountId,
  messageId,
  attachment,
  downloadState,
}: {
  accountId: string | null;
  messageId: string;
  attachment: MessageAttachment;
  downloadState: DownloadState;
}) {
  const prefetch = useLayoutStore((layout) => layout.prefetchImageAttachments);
  const { family, Icon, coloured, inkClassName, wellClassName } = resolveMimeIcon(
    attachment.mimeType,
    attachment.filename,
  );
  const wantsThumbnail = prefetch && family === 'image';
  const cachedQuery = useCachedAttachmentQuery({
    accountId: accountId,
    messageId: messageId,
    attachmentId: attachment.id,
    enabled: wantsThumbnail,
  });
  const thumbnailPath =
    wantsThumbnail && cachedQuery.isSuccess ? cachedQuery.data.displayPath : null;
  const thumbnailLoading = wantsThumbnail && cachedQuery.isPending;

  return (
    <div
      aria-hidden="true"
      className={`relative size-7 shrink-0 overflow-hidden rounded-chip ${chipWellClass({ downloadState, coloured, wellClassName, inkClassName })} grid place-items-center ${thumbnailLoading ? 'animate-pulse' : ''}`}
    >
      {renderWellContent({
        downloadState: downloadState,
        thumbnailPath: thumbnailPath,
        thumbnailLoading: thumbnailLoading,
        Icon: Icon,
      })}
    </div>
  );
}

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
  const { downloadState, download } = useAttachmentDownload({ accountId, messageId, attachment });
  const subtitleTone =
    downloadState === 'failed'
      ? 'text-error dark:text-dark-error'
      : 'text-outline dark:text-dark-outline';

  return (
    <div
      data-testid={`received-attachment-chip-${attachment.id}`}
      className={`relative flex max-w-56 items-center gap-stack-gap-sm rounded-chip border border-outline-variant bg-surface-container-low p-1.5 shadow-segment dark:border-dark-outline-variant dark:bg-dark-surface-container-low dark:shadow-none ${downloadState === 'downloading' ? 'opacity-60' : ''}`}
    >
      <button
        type="button"
        aria-label={`Preview ${attachment.filename}`}
        onClick={onPreview}
        className="absolute inset-0 z-10 cursor-pointer rounded-chip focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary"
      />
      <AttachmentThumbnailWell
        accountId={accountId}
        messageId={messageId}
        attachment={attachment}
        downloadState={downloadState}
      />
      <div className="min-w-0 flex-1">
        <p
          title={attachment.filename}
          className="truncate text-snippet text-on-surface dark:text-dark-on-surface"
        >
          {attachment.filename}
        </p>
        <p className={`truncate text-label-sm ${subtitleTone}`}>
          {downloadSubtitle(downloadState, attachment.size)}
        </p>
      </div>
      <AttachmentDownloadButton
        downloadState={downloadState}
        filename={attachment.filename}
        onDownload={() => void download()}
      />
    </div>
  );
}
