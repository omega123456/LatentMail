import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightContactSuggestions = [] satisfies IpcCommandMap['lookup_contacts']['result'];

export const playwrightContactSuggestionMatches = [
  { address: 'marta.oliveira@example.com', displayName: 'Marta Oliveira' },
  { address: 'm.bell@partner.io', displayName: 'Marcus Bell' },
  { address: 'marketing@example.com', displayName: null },
] satisfies IpcCommandMap['lookup_contacts']['result'];

export const playwrightStagedAttachment = {
  id: 'staged-1',
  filename: 'attachment.txt',
  mimeType: 'text/plain',
  path: '/staged/attachment.txt',
  contentId: null,
  size: 2048,
} satisfies IpcCommandMap['stage_attachment_from_path']['result'];
