export type PreviewKind =
  'image' | 'pdf' | 'text' | 'json' | 'javascript' | 'csv' | 'docx' | 'unsupported';

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function resolvePreviewKind(mimeType: string, filename: string): PreviewKind {
  const mime = mimeType.toLowerCase();
  const extension = extensionOf(filename);

  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime === 'text/csv' || extension === 'csv') return 'csv';
  if (
    mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    extension === 'docx'
  )
    return 'docx';
  if (mime === 'application/json' || extension === 'json') return 'json';
  if (
    mime === 'application/javascript' ||
    mime === 'text/javascript' ||
    extension === 'js' ||
    extension === 'jsx' ||
    extension === 'mjs'
  )
    return 'javascript';
  if (mime.startsWith('text/')) return 'text';

  return 'unsupported';
}
