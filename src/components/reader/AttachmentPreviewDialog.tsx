import { useEffect, useState, type ReactNode } from 'react';
import { Download, File, Loader2 } from 'lucide-react';
import { sanitizeFilename } from '@/lib/attachments/filename';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc } from '@/lib/ipc/dispatch';
import { parseCsv } from '@/lib/attachments/csv';
import { resolvePreviewKind, type PreviewKind } from '@/lib/attachments/kind';
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
import { ICON_SIZE } from '@/components/shared/icon-size';

type PdfPreviewComponent = (typeof import('./previews/PdfPreview'))['PdfPreview'];

const TEXT_KINDS: ReadonlySet<PreviewKind> = new Set(['text', 'json', 'javascript', 'csv']);

function isTextPreviewKind(kind: PreviewKind): boolean {
  return TEXT_KINDS.has(kind);
}

function usePreviewBytes({
  accountId,
  messageId,
  attachmentId,
  enabled,
}: {
  accountId: string | null;
  messageId: string;
  attachmentId: string;
  enabled: boolean;
}) {
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
        if (!cancelled) setState({ key: key, bytes: bytes, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ key: key, bytes: null, failed: true });
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
        if (!cancelled) setState({ enabled: enabled, component: PdfPreview, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ enabled: enabled, component: null, failed: true });
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
        if (!cancelled) setState({ bytes: bytes, html: result.value, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ bytes: bytes, html: null, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [bytes]);
  return state.bytes === bytes ? state : { html: null, failed: false };
}

type PreviewResources = {
  kind: PreviewKind;
  filename: string;
  imagePending: boolean;
  imageError: boolean;
  imageDisplayPath: string | undefined;
  bytes: ArrayBuffer | null;
  bytesFailed: boolean;
  PdfPreview: PdfPreviewComponent | null;
  pdfFailed: boolean;
  textPending: boolean;
  textError: boolean;
  textData: string | undefined;
  docxHtml: string | null;
  docxFailed: boolean;
};

function isPdfLoading(resources: PreviewResources): boolean {
  if (resources.bytesFailed || resources.pdfFailed) return false;
  return !resources.bytes || !resources.PdfPreview;
}

function isDocxLoading(resources: PreviewResources): boolean {
  if (resources.bytesFailed) return false;
  return !resources.bytes || (!resources.docxHtml && !resources.docxFailed);
}

const LOADING_CHECKERS: Partial<Record<PreviewKind, (resources: PreviewResources) => boolean>> = {
  image: (resources) => resources.imagePending,
  pdf: isPdfLoading,
  docx: isDocxLoading,
  text: (resources) => resources.textPending,
  json: (resources) => resources.textPending,
  javascript: (resources) => resources.textPending,
  csv: (resources) => resources.textPending,
};

function isPreviewLoading(resources: PreviewResources): boolean {
  const check = LOADING_CHECKERS[resources.kind];
  return check ? check(resources) : false;
}

function isPreviewFailed(resources: PreviewResources): boolean {
  if (resources.kind === 'image') return resources.imageError;
  if (isTextPreviewKind(resources.kind)) return resources.textError;
  if (resources.kind === 'pdf') return resources.bytesFailed || resources.pdfFailed;
  if (resources.kind === 'docx') return resources.bytesFailed || resources.docxFailed;
  return false;
}

const PREVIEW_RENDERERS: Partial<
  Record<PreviewKind, (resources: PreviewResources) => ReactNode | null>
> = {
  image: (resources) =>
    resources.imageDisplayPath ? (
      <ImagePreview
        src={dispatchConvertFileSrc(resources.imageDisplayPath)}
        filename={resources.filename}
      />
    ) : null,
  pdf: (resources) => {
    if (!resources.bytes || !resources.PdfPreview) return null;
    const PdfComponent = resources.PdfPreview;
    return <PdfComponent bytes={resources.bytes} />;
  },
  csv: (resources) =>
    resources.textData !== undefined ? <CsvPreview rows={parseCsv(resources.textData)} /> : null,
  text: (resources) =>
    resources.textData !== undefined ? <TextPreview text={resources.textData} /> : null,
  json: (resources) =>
    resources.textData !== undefined ? <TextPreview text={resources.textData} /> : null,
  javascript: (resources) =>
    resources.textData !== undefined ? <TextPreview text={resources.textData} /> : null,
  docx: (resources) =>
    resources.docxHtml !== null ? <DocxPreview html={resources.docxHtml} /> : null,
};

function renderPreviewContent(resources: PreviewResources): ReactNode {
  if (isPreviewLoading(resources)) {
    return (
      <ReaderDialogStatus>
        <Loader2 className="animate-spin" size={ICON_SIZE.xl2} aria-hidden="true" />
        <span>Loading preview…</span>
      </ReaderDialogStatus>
    );
  }
  if (isPreviewFailed(resources)) {
    return (
      <ReaderDialogStatus>
        <File
          size={ICON_SIZE.xl4}
          aria-hidden="true"
          className="text-outline dark:text-dark-outline"
        />
        <p>
          Couldn&apos;t load preview.
          <br />
          Use Download to save the file.
        </p>
      </ReaderDialogStatus>
    );
  }
  const rendered = PREVIEW_RENDERERS[resources.kind]?.(resources);
  return rendered ?? <UnsupportedPreview />;
}

function useAttachmentPreviewResources({
  accountId,
  messageId,
  attachment,
}: {
  accountId: string | null;
  messageId: string;
  attachment: MessageAttachment;
}): PreviewResources {
  const kind = resolvePreviewKind(attachment.mimeType, attachment.filename);
  const imageQuery = useCachedAttachmentQuery({
    accountId: accountId,
    messageId: messageId,
    attachmentId: attachment.id,
    enabled: kind === 'image',
  });
  const previewBytes = usePreviewBytes({
    accountId: accountId,
    messageId: messageId,
    attachmentId: attachment.id,
    enabled: kind === 'pdf' || kind === 'docx',
  });
  const pdf = usePdfPreview(kind === 'pdf');
  const textQuery = useAttachmentTextQuery({
    accountId: accountId,
    messageId: messageId,
    attachmentId: attachment.id,
    enabled: isTextPreviewKind(kind),
  });
  const docx = useDocxHtml(kind === 'docx' ? (previewBytes.bytes ?? undefined) : undefined);

  return {
    kind: kind,
    filename: attachment.filename,
    imagePending: imageQuery.isPending,
    imageError: imageQuery.isError,
    imageDisplayPath: imageQuery.data?.displayPath,
    bytes: previewBytes.bytes,
    bytesFailed: previewBytes.failed,
    PdfPreview: pdf.component,
    pdfFailed: pdf.failed,
    textPending: textQuery.isPending,
    textError: textQuery.isError,
    textData: textQuery.data,
    docxHtml: docx.html,
    docxFailed: docx.failed,
  };
}

async function downloadAttachmentWithToast(input: {
  accountId: string | null;
  messageId: string;
  attachment: MessageAttachment;
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
}) {
  if (!input.accountId) return;
  const destination = await invoke('plugin:dialog|save', {
    options: { defaultPath: sanitizeFilename(input.attachment.filename) },
  });
  if (!destination) return;
  try {
    await invoke('save_attachment_to_path', {
      accountId: input.accountId,
      messageId: input.messageId,
      attachmentId: input.attachment.id,
      destination: destination,
    });
    input.showSuccess(`Downloaded ${input.attachment.filename}`);
  } catch {
    input.showError(`Couldn't download ${input.attachment.filename}`);
  }
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
  const showSuccess = useToastStore((toaster) => toaster.showSuccess);
  const showError = useToastStore((toaster) => toaster.showError);
  const resources = useAttachmentPreviewResources({ accountId, messageId, attachment });

  const download = () =>
    downloadAttachmentWithToast({
      accountId: accountId,
      messageId: messageId,
      attachment: attachment,
      showSuccess: showSuccess,
      showError: showError,
    });

  return (
    <ReaderDialogFrame
      title={attachment.filename}
      testId="attachment-preview-modal"
      closeLabel="Close preview"
      onClose={onClose}
      actions={
        <button type="button" onClick={() => void download()} className={dialogPrimaryButtonClass}>
          <Download size={ICON_SIZE.sm} aria-hidden="true" />
          Download
        </button>
      }
    >
      {renderPreviewContent(resources)}
    </ReaderDialogFrame>
  );
}
