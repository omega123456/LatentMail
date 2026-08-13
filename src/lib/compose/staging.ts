import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@/lib/ipc/commands';
import { dispatchConvertFileSrc } from '@/lib/ipc/dispatch';
import type { StagedAttachment } from '@/lib/types/ipc';

/** Opens the platform file picker (multi-select, any file type — filtering
 * to images alone is the caller's job via `pickImages`) and stages every
 * selected path into Rust-owned canonical compose staging. Both the picker
 * and `file-drop.ts`'s native drop path converge on `stageAttachmentPaths`
 * below, so one Rust reader really does serve both (D7). */
export async function pickAttachments(): Promise<string[]> {
  const selection = await open({ multiple: true });
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

/** Same picker, filtered to image extensions for the inline-image control
 * (FR "the inline-image control accepts images only"). The filter narrows
 * what the *picker* offers; Rust's own staging still owns final authority
 * over what actually gets read. */
export async function pickImages(): Promise<string[]> {
  const selection = await open({
    multiple: false,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }],
  });
  if (!selection) return [];
  return Array.isArray(selection) ? selection : [selection];
}

/** Best-effort client-side MIME guess from a file extension — a picker/drop
 * hands back only a path, never a `File` object with its own `.type`.
 * Never authoritative: Rust staging reads the real bytes regardless. */
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

/** Stages one selected/dropped path into Rust-owned canonical compose
 * staging, resolved to a scoped Tauri asset URL in the same call so callers
 * never separately reconstruct one from a raw filesystem path.
 *
 * `contentId` distinguishes an ordinary attachment (`null` — shown only as
 * a chip) from an inline image (a generated bare Content-ID token the outgoing
 * MIME assembly will later resolve — Phase 5's job, not this one's). */
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

/** A bare Content-ID token unique enough for one compose session's inline
 * images. The document uses `cid:<token>` while MIME uses `<token>`. */
export function generateInlineContentId(): string {
  return `${crypto.randomUUID()}@latentmail`;
}
