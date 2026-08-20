import { getTime, parseISO } from 'date-fns';
import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightUpdateAvailable: IpcCommandMap['check_for_update']['result'] = {
  currentVersion: '0.1.0',
  available: {
    version: '0.1.1',
    notes:
      'Attachment previews open without leaving the reader.\nThe tray icon reports accounts that need re-authentication.\nFixes a crash when a conversation carried no plain-text part.',
    dateMillis: getTime(parseISO('2026-08-20T00:00:00.000Z')),
  },
};
