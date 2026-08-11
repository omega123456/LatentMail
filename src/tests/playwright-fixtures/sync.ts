import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightSyncStatus: IpcCommandMap['read_sync_status']['result'] = {
  accountId: '',
  state: 'idle',
  lastSyncedAt: null,
  lastError: null,
};

export const playwrightTriggerSyncResult: IpcCommandMap['trigger_sync']['result'] = {
  ...playwrightSyncStatus,
};
