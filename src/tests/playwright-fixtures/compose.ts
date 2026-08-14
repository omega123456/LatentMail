import type { IpcCommandMap } from '@/lib/types/ipc';

/** Phase 2 owns the shared compose domain fixture; later phases extend it.
 * Empty by default so no scenario pops a suggestion listbox it did not ask
 * for — the suggestion screenshot overrides this with the set below. */
export const playwrightContactSuggestions = [] satisfies IpcCommandMap['lookup_contacts']['result'];

/** Two named contacts and one address-only contact, so the screenshot
 * covers both option shapes the component renders. */
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
