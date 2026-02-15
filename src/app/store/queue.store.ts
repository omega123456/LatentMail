import { computed, inject } from '@angular/core';
import { signalStore, withState, withMethods, withComputed, patchState, withHooks } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';

export interface QueueItemSnapshot {
  queueId: string;
  accountId: number;
  type: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt: string;
  completedAt?: string;
  retryCount: number;
  error?: string;
  description: string;
}

interface QueueState {
  items: QueueItemSnapshot[];
  loading: boolean;
}

const initialState: QueueState = {
  items: [],
  loading: false,
};

export const QueueStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),

  withComputed((store) => ({
    pendingCount: computed(() => store.items().filter(i => i.status === 'pending').length),
    processingCount: computed(() => store.items().filter(i => i.status === 'processing').length),
    completedCount: computed(() => store.items().filter(i => i.status === 'completed').length),
    failedCount: computed(() => store.items().filter(i => i.status === 'failed').length),
    totalCount: computed(() => store.items().length),
    hasItems: computed(() => store.items().length > 0),
  })),

  withMethods((store) => {
    const electronService = inject(ElectronService);

    return {
      /** Fetch full queue state from the main process (used on init / refresh). */
      async loadStatus(): Promise<void> {
        patchState(store, { loading: true });
        try {
          const response = await electronService.getQueueStatus();
          if (response.success && response.data) {
            const { items } = response.data as { items: QueueItemSnapshot[] };
            patchState(store, { items, loading: false });
          } else {
            patchState(store, { loading: false });
          }
        } catch {
          patchState(store, { loading: false });
        }
      },

      /** Handle a queue:update push event from the main process. */
      handleUpdate(update: QueueItemSnapshot): void {
        const currentItems = [...store.items()];
        const idx = currentItems.findIndex(i => i.queueId === update.queueId);
        if (idx >= 0) {
          currentItems[idx] = update;
        } else {
          currentItems.push(update);
        }
        patchState(store, { items: currentItems });
      },

      async retryAll(): Promise<number> {
        const response = await electronService.retryFailedOperations();
        if (response.success && response.data) {
          return (response.data as { retriedCount: number }).retriedCount;
        }
        return 0;
      },

      async retrySingle(queueId: string): Promise<void> {
        await electronService.retryFailedOperations(queueId);
      },

      async clearCompleted(): Promise<number> {
        const response = await electronService.clearCompletedOperations();
        if (response.success && response.data) {
          const { clearedCount } = response.data as { clearedCount: number };
          // Remove completed items from local state too
          patchState(store, {
            items: store.items().filter(i => i.status !== 'completed'),
          });
          return clearedCount;
        }
        return 0;
      },

      async cancelOperation(queueId: string): Promise<void> {
        await electronService.cancelOperation(queueId);
      },
    };
  }),

  withHooks({
    onInit(store) {
      // Load initial queue state
      store.loadStatus();

      // Subscribe to real-time queue updates.
      // QueueStore is providedIn: 'root' (singleton), so this subscription
      // lives for the app's lifetime — no cleanup needed.
      // ElectronService.onEvent() already wraps callbacks in NgZone.
      const electronService = inject(ElectronService);
      electronService.onEvent<QueueItemSnapshot>('queue:update').subscribe((update) => {
        store.handleUpdate(update);
      });
    },
  }),
);
