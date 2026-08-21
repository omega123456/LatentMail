import { create } from 'zustand';
import { invoke } from '@/lib/ipc/commands';
import { appLog } from '@/lib/app-log';
import { useToastStore } from '@/stores/toast';
import type { QueueSummary, SyncStatus } from '@/lib/types/ipc';

export type SyncState = 'idle' | 'syncing' | 'error';

const emptySummary: QueueSummary = {
  pending: 0,
  active: 0,
  failed: 0,
  done: 0,
  paused: false,
  suspended: false,
};

const SYNC_FAILURE_MESSAGE = "Couldn't sync your mail. Check your connection and try again.";

type Store = {
  queue: QueueSummary;
  syncState: SyncState;
  lastSynced: Date | null;
  error?: string;
  accountId: string | null;
  refreshing: boolean;
  hydrate: () => Promise<void>;
  hydrateSync: (accountId: string) => Promise<void>;
  triggerSync: (accountId: string) => Promise<void>;
  setQueue: (queue: QueueSummary) => void;
  setSyncState: (state: SyncState) => void;
  applyStatus: (status: SyncStatus) => void;
};

let hydration: Promise<void> | undefined;

export const useSyncStore = create<Store>((set, get) => ({
  queue: emptySummary,
  syncState: 'idle',
  lastSynced: null,
  accountId: null,
  refreshing: false,
  hydrate: () => {
    hydration ??= invoke('read_queue_summary', {}).then((queue) => set({ queue }));
    return hydration;
  },
  hydrateSync: async (accountId) => {
    const status = await invoke('read_sync_status', { accountId });
    get().applyStatus(status);
  },
  triggerSync: async (accountId) => {
    set({ refreshing: true });
    appLog.info(`action sync requested for ${accountId}`);
    try {
      const status = await invoke('trigger_sync', { accountId });
      appLog.info(`action sync returned ${status.state} (lastSyncedAt=${status.lastSyncedAt})`);
      get().applyStatus(status);
    } finally {
      set({ refreshing: false });
    }
  },
  setQueue: (queue) => set({ queue }),
  setSyncState: (state) => {
    if (state === 'error' && get().syncState !== 'error' && !get().queue.suspended)
      useToastStore.getState().showError(SYNC_FAILURE_MESSAGE);
    set({ syncState: state });
  },
  applyStatus: (status) => {
    if (status.lastError) appLog.error(`sync failed: ${status.lastError}`);
    get().setSyncState(status.state);
    set({
      accountId: status.accountId,
      lastSynced: status.lastSyncedAt !== null ? new Date(status.lastSyncedAt) : null,
      error: status.lastError ?? undefined,
    });
  },
}));
