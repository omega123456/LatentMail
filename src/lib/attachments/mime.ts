import { extensionOf } from '@/lib/format/strings';

export type PreviewKind =
  'image' | 'pdf' | 'text' | 'json' | 'javascript' | 'csv' | 'docx' | 'unsupported';

export type MimeFamily =
  | 'pdf'
  | 'document'
  | 'spreadsheet'
  | 'presentation'
  | 'image'
  | 'archive'
  | 'video'
  | 'audio'
  | 'text-code'
  | 'generic';

type MimeCategoryRule = {
  family: MimeFamily;
  previewKind?: PreviewKind;
  matches: (mime: string, extension: string) => boolean;
};

const ARCHIVE_EXTENSIONS = ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'];
const SPREADSHEET_EXTENSIONS = ['xls', 'xlsx', 'csv', 'ods'];
const PRESENTATION_EXTENSIONS = ['ppt', 'pptx', 'odp'];
const DOCUMENT_EXTENSIONS = ['doc', 'docx', 'odt', 'rtf'];
const JAVASCRIPT_EXTENSIONS = ['js', 'jsx', 'mjs'];
const TEXT_CODE_EXTENSIONS = [
  'txt',
  'md',
  'json',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'rs',
  'go',
  'java',
  'c',
  'cpp',
  'h',
  'css',
  'html',
  'xml',
  'yaml',
  'yml',
  'sh',
];

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function isPdf(mime: string, extension: string): boolean {
  return mime === 'application/pdf' || extension === 'pdf';
}

function isCsv(mime: string, extension: string): boolean {
  return mime === 'text/csv' || extension === 'csv';
}

function isDocx(mime: string, extension: string): boolean {
  return mime === DOCX_MIME || extension === 'docx';
}

function isJson(mime: string, extension: string): boolean {
  return mime === 'application/json' || extension === 'json';
}

function isJavascript(mime: string, extension: string): boolean {
  return (
    mime === 'application/javascript' ||
    mime === 'text/javascript' ||
    JAVASCRIPT_EXTENSIONS.includes(extension)
  );
}

const MIME_FAMILY_RULES: MimeCategoryRule[] = [
  { family: 'pdf', matches: isPdf },
  { family: 'image', matches: (mime) => mime.startsWith('image/') },
  { family: 'video', matches: (mime) => mime.startsWith('video/') },
  { family: 'audio', matches: (mime) => mime.startsWith('audio/') },
  {
    family: 'archive',
    matches: (mime, extension) =>
      mime.includes('zip') ||
      mime.includes('compressed') ||
      mime.includes('archive') ||
      mime === 'application/x-tar' ||
      mime === 'application/gzip' ||
      ARCHIVE_EXTENSIONS.includes(extension),
  },
  {
    family: 'spreadsheet',
    matches: (mime, extension) =>
      mime.includes('spreadsheet') ||
      mime.includes('excel') ||
      isCsv(mime, extension) ||
      SPREADSHEET_EXTENSIONS.includes(extension),
  },
  {
    family: 'presentation',
    matches: (mime, extension) =>
      mime.includes('presentation') ||
      mime.includes('powerpoint') ||
      PRESENTATION_EXTENSIONS.includes(extension),
  },
  {
    family: 'document',
    matches: (mime, extension) =>
      mime.includes('wordprocessingml') ||
      mime === 'application/msword' ||
      mime.includes('opendocument.text') ||
      DOCUMENT_EXTENSIONS.includes(extension),
  },
  {
    family: 'text-code',
    matches: (mime, extension) =>
      mime.startsWith('text/') ||
      isJson(mime, extension) ||
      isJavascript(mime, extension) ||
      TEXT_CODE_EXTENSIONS.includes(extension),
  },
];

const PREVIEW_KIND_RULES: Array<{
  kind: PreviewKind;
  matches: (mime: string, extension: string) => boolean;
}> = [
  { kind: 'image', matches: (mime) => mime.startsWith('image/') },
  { kind: 'pdf', matches: isPdf },
  { kind: 'csv', matches: isCsv },
  { kind: 'docx', matches: isDocx },
  { kind: 'json', matches: isJson },
  { kind: 'javascript', matches: isJavascript },
  { kind: 'text', matches: (mime) => mime.startsWith('text/') },
];

export function classifyMimeFamily(mimeType: string, filename: string): MimeFamily {
  const mime = mimeType.toLowerCase();
  const extension = extensionOf(filename);
  const matched = MIME_FAMILY_RULES.find((rule) => rule.matches(mime, extension));
  return matched ? matched.family : 'generic';
}

export function classifyPreviewKind(mimeType: string, filename: string): PreviewKind {
  const mime = mimeType.toLowerCase();
  const extension = extensionOf(filename);
  const matched = PREVIEW_KIND_RULES.find((rule) => rule.matches(mime, extension));
  return matched ? matched.kind : 'unsupported';
}
