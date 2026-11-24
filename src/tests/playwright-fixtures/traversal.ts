import { getTime, parseISO } from 'date-fns';
import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightTraversalStatus: IpcCommandMap['read_traversal_status']['result'] = {
  accountId: '',
  state: 'notStarted',
  kind: null,
  discoveredCount: 0,
  persistedCount: 0,
  lastAdvancedAt: null,
  isResumed: false,
};

export const playwrightBackfillingTraversalStatus: IpcCommandMap['read_traversal_status']['result'] =
  {
    accountId: 'mail-account',
    state: 'backfilling',
    kind: 'backfill',
    discoveredCount: 48110,
    persistedCount: 31402,
    lastAdvancedAt: getTime(parseISO('2026-08-12T10:00:00Z')),
    isResumed: false,
  };
