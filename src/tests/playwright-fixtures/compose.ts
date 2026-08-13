import type { IpcCommandMap } from '@/lib/types/ipc';

/** Phase 2 owns the shared compose domain fixture; later phases extend it. */
export const playwrightContactSuggestions = [] satisfies IpcCommandMap['lookup_contacts']['result'];

export const playwrightStagedAttachment = {
  id: 'staged-1',
  filename: 'attachment.txt',
  mimeType: 'text/plain',
  path: '/staged/attachment.txt',
  contentId: null,
  size: 2048,
} satisfies IpcCommandMap['stage_attachment_from_path']['result'];
