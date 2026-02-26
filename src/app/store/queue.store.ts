import { computed, inject } from '@angular/core';
import { signalStore, withState, withMethods, withComputed, patchState, withHooks } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { ToastService } from '../core/services/toast.service';

export interface QueueItemSnapshot {
  queueId: string;
  accountId: number;
  type: string;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
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
    cancelledCount: computed(() => store.items().filter(i => i.status === 'cancelled').length),
    totalCount: computed(() => store.items().length),
    hasItems: computed(() => store.items().length > 0),
    /** Total count of pending + processing items (used for queue status badge). */
    activeCount: computed(() => store.items().filter(i => i.status === 'pending' || i.status === 'processing').length),
    /** Description of the currently processing item, or null when queue is idle. */
    currentProcessingDescription: computed(() => {
      const processing = store.items().find(i => i.status === 'processing');
      return processing?.description ?? null;
    }),
  })),

  withMethods((store) => {
    const electronService = inject(ElectronService);
    const toastService = inject(ToastService);

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
        const isSyncOp = update.type === 'sync-folder' || update.type === 'sync-thread';

        // Detect status transitions for toast notifications.
        if (idx >= 0) {
          const previousStatus = currentItems[idx].status;
          if (previousStatus !== update.status) {
            // Suppress failure toasts for background sync operations — they are transient
            // and will be retried automatically on the next sync tick.
            if (update.status === 'failed' && !isSyncOp) {
              toastService.error(`${update.description} failed: ${update.error || 'Unknown error'}`);
            } else if (update.status === 'completed' && update.type === 'send') {
              toastService.success('Email sent successfully');
            }
          }
          currentItems[idx] = update;
        } else {
          // New item (e.g. real-time push). Show failure toast if it arrives already failed,
          // so user sees feedback when move/delete/send fails before a prior pending/processing
          // update was applied (e.g. fast failure or out-of-order delivery).
          if (update.status === 'failed' && !isSyncOp) {
            toastService.error(`${update.description} failed: ${update.error || 'Unknown error'}`);
          }
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
          // Remove completed and cancelled items from local state too
          patchState(store, {
            items: store.items().filter(i => i.status !== 'completed' && i.status !== 'cancelled'),
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
