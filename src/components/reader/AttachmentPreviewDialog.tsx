import { useEffect, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Download, File, Loader2, X } from 'lucide-react';
import { sanitizeFilename } from '@/lib/attachments/filename';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc } from '@/lib/ipc/dispatch';
import { parseCsv } from '@/lib/attachments/csv';
import { resolvePreviewKind } from '@/lib/attachments/kind';
import { useAttachmentTextQuery, useCachedAttachmentQuery } from '@/lib/query/hooks';
import { useToastStore } from '@/stores/toast';
import type { MessageAttachment } from '@/lib/types/ipc';
import { CsvPreview } from './previews/CsvPreview';
import { DocxPreview } from './previews/DocxPreview';
import { ImagePreview } from './previews/ImagePreview';
import { TextPreview } from './previews/TextPreview';
import { UnsupportedPreview } from './previews/UnsupportedPreview';

type PdfPreviewComponent = (typeof import('./previews/PdfPreview'))['PdfPreview'];

function usePreviewBytes(
  accountId: string | null,
  messageId: string,
  attachmentId: string,
  enabled: boolean,
) {
  const key = enabled && accountId ? `${accountId}:${messageId}:${attachmentId}` : '';
  const [state, setState] = useState<{ key: string; bytes: ArrayBuffer | null; failed: boolean }>({
    key: '',
    bytes: null,
    failed: false,
  });
  useEffect(() => {
    if (!key || !accountId) return;
    let cancelled = false;
    void invoke('read_attachment_bytes', { accountId, messageId, attachmentId })
      .then((bytes) => {
        if (!cancelled) setState({ key, bytes, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ key, bytes: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [accountId, attachmentId, key, messageId]);
  return state.key === key ? state : { bytes: null, failed: false };
}

function usePdfPreview(enabled: boolean) {
  const [state, setState] = useState<{
    enabled: boolean;
    component: PdfPreviewComponent | null;
    failed: boolean;
  }>({
    enabled: false,
    component: null,
    failed: false,
  });
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void import('./previews/PdfPreview')
      .then(({ PdfPreview }) => {
        if (!cancelled) setState({ enabled, component: PdfPreview, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ enabled, component: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return state.enabled === enabled ? state : { component: null, failed: false };
}

function useDocxHtml(bytes: ArrayBuffer | undefined) {
  const [state, setState] = useState<{
    bytes: ArrayBuffer | undefined;
    html: string | null;
    failed: boolean;
  }>({ bytes: undefined, html: null, failed: false });
  useEffect(() => {
    if (!bytes) return;
    let cancelled = false;
    void import('mammoth')
      .then((mammoth) => mammoth.convertToHtml({ arrayBuffer: bytes }))
      .then((result) => {
        if (!cancelled) setState({ bytes, html: result.value, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ bytes, html: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  return state.bytes === bytes ? state : { html: null, failed: false };
}

function portalTarget(): HTMLElement | undefined {
  return document.getElementById('root') ?? undefined;
}

export function AttachmentPreviewDialog({
  accountId,
  messageId,
  attachment,
  onClose,
}: {
  accountId: string | null;
  messageId: string;
  attachment: MessageAttachment;
  onClose: () => void;
}) {
  const showSuccess = useToastStore((state) => state.showSuccess);
  const showError = useToastStore((state) => state.showError);
  const kind = resolvePreviewKind(attachment.mimeType, attachment.filename);

  const imageQuery = useCachedAttachmentQuery(
    accountId,
    messageId,
    attachment.id,
    kind === 'image',
  );
  const previewBytes = usePreviewBytes(
    accountId,
    messageId,
    attachment.id,
    kind === 'pdf' || kind === 'docx',
  );
  const pdf = usePdfPreview(kind === 'pdf');
  const textQuery = useAttachmentTextQuery(
    accountId,
    messageId,
    attachment.id,
    kind === 'text' || kind === 'json' || kind === 'javascript' || kind === 'csv',
  );
  const docx = useDocxHtml(kind === 'docx' ? (previewBytes.bytes ?? undefined) : undefined);
  const PdfPreview = pdf.component;

  const loading =
    (kind === 'image' && imageQuery.isPending) ||
    (kind === 'pdf' &&
      (!previewBytes.bytes || !pdf.component) &&
      !previewBytes.failed &&
      !pdf.failed) ||
    ((kind === 'text' || kind === 'json' || kind === 'javascript' || kind === 'csv') &&
      textQuery.isPending) ||
    (kind === 'docx' &&
      (!previewBytes.bytes || (!docx.html && !docx.failed)) &&
      !previewBytes.failed);

  const failedAcquisition =
    (kind === 'image' && imageQuery.isError) ||
    (kind === 'pdf' && (previewBytes.failed || pdf.failed)) ||
    ((kind === 'text' || kind === 'json' || kind === 'javascript' || kind === 'csv') &&
      textQuery.isError) ||
    (kind === 'docx' && (previewBytes.failed || docx.failed));

  const download = async () => {
    if (!accountId) return;
    const destination = await invoke('plugin:dialog|save', {
      options: { defaultPath: sanitizeFilename(attachment.filename) },
    });
    if (!destination) return;
    try {
      await invoke('save_attachment_to_path', {
        accountId,
        messageId,
        attachmentId: attachment.id,
        destination,
      });
      showSuccess(`Downloaded ${attachment.filename}`);
    } catch {
      showError(`Couldn't download ${attachment.filename}`);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal container={portalTarget()}>
        <Dialog.Overlay className="absolute inset-0 z-40 bg-inverse-surface/40 dark:bg-black/60" />
        <Dialog.Content
          onClick={(event) => event.target === event.currentTarget && onClose()}
          className="absolute inset-0 z-50 grid place-items-center p-4 outline-none"
        >
          <div
            data-testid="attachment-preview-modal"
            className="flex h-11/12 max-h-preview-modal-h w-11/12 max-w-preview-modal-w flex-col overflow-hidden rounded-card bg-surface-container-lowest shadow-lg dark:bg-dark-surface-container-lowest"
          >
            <div className="flex items-center gap-stack-gap-sm border-b border-outline-variant p-3 dark:border-dark-outline-variant">
              <Dialog.Title
                title={attachment.filename}
                className="min-w-0 flex-1 truncate text-title-lg text-on-surface dark:text-dark-on-surface"
              >
                {attachment.filename}
              </Dialog.Title>
              <button
                type="button"
                onClick={() => void download()}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-chip bg-primary px-3 py-1.5 text-label-md font-semibold text-on-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary dark:bg-dark-primary dark:text-dark-on-primary"
              >
                <Download size={14} aria-hidden="true" />
                Download
              </button>
              <Dialog.Close asChild>
                <button
                  type="button"
                  aria-label="Close preview"
                  className="shrink-0 cursor-pointer rounded-chip p-1.5 text-secondary hover:bg-surface-container focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container"
                >
                  <X size={16} aria-hidden="true" />
                </button>
              </Dialog.Close>
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {loading ? (
                <div className="grid h-full place-items-center gap-stack-gap-sm text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                  <div className="flex flex-col items-center gap-stack-gap-sm">
                    <Loader2 className="animate-spin" size={22} aria-hidden="true" />
                    <span>Loading preview…</span>
                  </div>
                </div>
              ) : failedAcquisition ? (
                <div className="grid h-full place-items-center p-stack-gap-md text-center text-body-sm text-on-surface-variant dark:text-dark-on-surface-variant">
                  <div className="flex flex-col items-center gap-stack-gap-sm">
                    <File
                      size={26}
                      aria-hidden="true"
                      className="text-outline dark:text-dark-outline"
                    />
                    <p>
                      Couldn&apos;t load preview.
                      <br />
                      Use Download to save the file.
                    </p>
                  </div>
                </div>
              ) : kind === 'image' && imageQuery.data ? (
                <ImagePreview
                  src={dispatchConvertFileSrc(imageQuery.data.displayPath)}
                  filename={attachment.filename}
                />
              ) : kind === 'pdf' && previewBytes.bytes && PdfPreview ? (
                <PdfPreview bytes={previewBytes.bytes} />
              ) : kind === 'csv' && textQuery.data !== undefined ? (
                <CsvPreview rows={parseCsv(textQuery.data)} />
              ) : (kind === 'text' || kind === 'json' || kind === 'javascript') &&
                textQuery.data !== undefined ? (
                <TextPreview text={textQuery.data} />
              ) : kind === 'docx' && docx.html !== null ? (
                <DocxPreview html={docx.html} />
              ) : (
                <UnsupportedPreview />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
