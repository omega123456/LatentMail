import { useEffect, useState } from 'react';
import { Download, File, Loader2 } from 'lucide-react';
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
import {
  dialogPrimaryButtonClass,
  ReaderDialogFrame,
  ReaderDialogStatus,
} from './ReaderDialogFrame';

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
    <ReaderDialogFrame
      title={attachment.filename}
      testId="attachment-preview-modal"
      closeLabel="Close preview"
      onClose={onClose}
      actions={
        <button type="button" onClick={() => void download()} className={dialogPrimaryButtonClass}>
          <Download size={14} aria-hidden="true" />
          Download
        </button>
      }
    >
      {loading ? (
        <ReaderDialogStatus>
          <Loader2 className="animate-spin" size={22} aria-hidden="true" />
          <span>Loading preview…</span>
        </ReaderDialogStatus>
      ) : failedAcquisition ? (
        <ReaderDialogStatus>
          <File size={26} aria-hidden="true" className="text-outline dark:text-dark-outline" />
          <p>
            Couldn&apos;t load preview.
            <br />
            Use Download to save the file.
          </p>
        </ReaderDialogStatus>
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
    </ReaderDialogFrame>
  );
}
