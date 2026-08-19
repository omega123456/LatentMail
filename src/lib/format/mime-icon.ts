import {
  Archive,
  File,
  FileAudio,
  FileCode,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Image as ImageIcon,
  Presentation,
  type LucideIcon,
} from 'lucide-react';

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

export type MimeFamilyResolution = {
  family: MimeFamily;
  Icon: LucideIcon;
  coloured: boolean;
  inkClassName: string;
  wellClassName: string;
};

const NEUTRAL_INK = 'text-on-surface-variant dark:text-dark-on-surface-variant';
const NEUTRAL_WELL = 'bg-surface-container-high dark:bg-dark-surface-container-high';

const FAMILY_RESOLUTIONS: Record<
  MimeFamily,
  { Icon: LucideIcon; coloured: boolean; inkClassName: string; wellClassName: string }
> = {
  pdf: {
    Icon: FileText,
    coloured: true,
    inkClassName: 'text-filetype-pdf-ink dark:text-dark-filetype-pdf-ink',
    wellClassName: 'bg-filetype-pdf-well dark:bg-dark-filetype-pdf-well',
  },
  document: {
    Icon: FileText,
    coloured: true,
    inkClassName: 'text-filetype-document-ink dark:text-dark-filetype-document-ink',
    wellClassName: 'bg-filetype-document-well dark:bg-dark-filetype-document-well',
  },
  spreadsheet: {
    Icon: FileSpreadsheet,
    coloured: true,
    inkClassName: 'text-filetype-spreadsheet-ink dark:text-dark-filetype-spreadsheet-ink',
    wellClassName: 'bg-filetype-spreadsheet-well dark:bg-dark-filetype-spreadsheet-well',
  },
  presentation: {
    Icon: Presentation,
    coloured: true,
    inkClassName: 'text-filetype-presentation-ink dark:text-dark-filetype-presentation-ink',
    wellClassName: 'bg-filetype-presentation-well dark:bg-dark-filetype-presentation-well',
  },
  image: {
    Icon: ImageIcon,
    coloured: true,
    inkClassName: 'text-filetype-image-ink dark:text-dark-filetype-image-ink',
    wellClassName: 'bg-filetype-image-well dark:bg-dark-filetype-image-well',
  },
  archive: {
    Icon: Archive,
    coloured: true,
    inkClassName: 'text-filetype-archive-ink dark:text-dark-filetype-archive-ink',
    wellClassName: 'bg-filetype-archive-well dark:bg-dark-filetype-archive-well',
  },
  video: {
    Icon: FileVideo,
    coloured: false,
    inkClassName: NEUTRAL_INK,
    wellClassName: NEUTRAL_WELL,
  },
  audio: {
    Icon: FileAudio,
    coloured: false,
    inkClassName: NEUTRAL_INK,
    wellClassName: NEUTRAL_WELL,
  },
  'text-code': {
    Icon: FileCode,
    coloured: false,
    inkClassName: NEUTRAL_INK,
    wellClassName: NEUTRAL_WELL,
  },
  generic: {
    Icon: File,
    coloured: false,
    inkClassName: NEUTRAL_INK,
    wellClassName: NEUTRAL_WELL,
  },
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

export function resolveMimeFamily(mimeType: string, filename: string): MimeFamily {
  const mime = mimeType.toLowerCase();
  const extension = extensionOf(filename);

  if (mime === 'application/pdf' || extension === 'pdf') return 'pdf';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (
    mime.includes('zip') ||
    mime.includes('compressed') ||
    mime.includes('archive') ||
    mime === 'application/x-tar' ||
    mime === 'application/gzip' ||
    ['zip', 'rar', '7z', 'tar', 'gz', 'bz2'].includes(extension)
  )
    return 'archive';
  if (
    mime.includes('spreadsheet') ||
    mime.includes('excel') ||
    mime === 'text/csv' ||
    ['xls', 'xlsx', 'csv', 'ods'].includes(extension)
  )
    return 'spreadsheet';
  if (
    mime.includes('presentation') ||
    mime.includes('powerpoint') ||
    ['ppt', 'pptx', 'odp'].includes(extension)
  )
    return 'presentation';
  if (
    mime.includes('wordprocessingml') ||
    mime === 'application/msword' ||
    mime.includes('opendocument.text') ||
    ['doc', 'docx', 'odt', 'rtf'].includes(extension)
  )
    return 'document';
  if (
    mime.startsWith('text/') ||
    mime === 'application/json' ||
    mime === 'application/javascript' ||
    mime === 'text/javascript' ||
    [
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
    ].includes(extension)
  )
    return 'text-code';

  return 'generic';
}

export function resolveMimeIcon(mimeType: string, filename: string): MimeFamilyResolution {
  const family = resolveMimeFamily(mimeType, filename);
  return { family, ...FAMILY_RESOLUTIONS[family] };
}
