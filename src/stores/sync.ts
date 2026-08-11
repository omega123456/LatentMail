import { create } from 'zustand';
import { invoke } from '@/lib/ipc/commands';
import type { QueueSummary, SyncStatus } from '@/lib/types/ipc';

export type SyncState = 'idle' | 'syncing' | 'error';

const emptySummary: QueueSummary = { pending: 0, active: 0, failed: 0, done: 0, paused: false };

type Store = {
  queue: QueueSummary;
  syncState: SyncState;
  lastSynced: Date | null;
  error?: string;
  accountId: string | null;
  refreshing: boolean;
  hydrate: () => Promise<void>;
  /** Seeds `lastSynced`/`syncState` from Rust's read-sync-status command so
   * the status bar shows a correct value before the first `sync://complete`
   * event arrives (Phase 18 acceptance criterion 9). */
  hydrateSync: (accountId: string) => Promise<void>;
  /** Wires the status bar's refresh control to the real sync-trigger
   * command. */
  triggerSync: (accountId: string) => Promise<void>;
  setQueue: (queue: QueueSummary) => void;
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
    try {
      const status = await invoke('trigger_sync', { accountId });
      get().applyStatus(status);
    } finally {
      set({ refreshing: false });
    }
  },
  setQueue: (queue) => set({ queue }),
  applyStatus: (status) =>
    set({
      accountId: status.accountId,
      syncState: status.state,
      lastSynced: status.lastSyncedAt !== null ? new Date(status.lastSyncedAt) : null,
      error: status.lastError ?? undefined,
    }),
}));
