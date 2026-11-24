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
import { classifyMimeFamily, type MimeFamily } from '@/lib/attachments/mime';

export type { MimeFamily };

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

export function resolveMimeFamily(mimeType: string, filename: string): MimeFamily {
  return classifyMimeFamily(mimeType, filename);
}

export function resolveMimeIcon(mimeType: string, filename: string): MimeFamilyResolution {
  const family = resolveMimeFamily(mimeType, filename);
  return { family, ...FAMILY_RESOLUTIONS[family] };
}
