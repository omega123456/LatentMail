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
