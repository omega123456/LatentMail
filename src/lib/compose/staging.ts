import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc } from '@/lib/ipc/dispatch';
import type { StagedAttachment } from '@/lib/types/ipc';

export async function pickAttachments(): Promise<string[]> {
  const selection = await open({ multiple: true });
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

export async function pickImages(): Promise<string[]> {
  const selection = await open({
    multiple: false,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  });
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

export function guessMimeType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      pdf: 'application/pdf',
      txt: 'text/plain',
      csv: 'text/csv',
      json: 'application/json',
      zip: 'application/zip',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      mp4: 'video/mp4',
      mov: 'video/quicktime',
      mp3: 'audio/mpeg',
      wav: 'audio/wav',
    }[extension] ?? 'application/octet-stream'
  );
}

export async function stageAttachmentPath(
  accountId: string,
  owner: string,
  path: string,
  contentId: string | null = null,
): Promise<StagedAttachment & { assetUrl: string }> {
  const mimeType = guessMimeType(path);
  const staged = await invoke('stage_attachment_from_path', {
    accountId,
    owner,
    path,
    mimeType,
    contentId,
  });
  return { ...staged, assetUrl: dispatchConvertFileSrc(staged.path) };
}

export function generateInlineContentId(): string {
  return `${crypto.randomUUID()}@latentmail`;
}
