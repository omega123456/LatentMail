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
  bodyFetchItems: QueueItemSnapshot[];
  loading: boolean;
}

const initialState: QueueState = {
  items: [],
  bodyFetchItems: [],
  loading: false,
};

export const QueueStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),

  withComputed((store) => ({
    // --- Main mail queue computeds ---
    pendingCount: computed(() => store.items().filter(item => item.status === 'pending').length),
    processingCount: computed(() => store.items().filter(item => item.status === 'processing').length),
    completedCount: computed(() => store.items().filter(item => item.status === 'completed').length),
    failedCount: computed(() => store.items().filter(item => item.status === 'failed').length),
    cancelledCount: computed(() => store.items().filter(item => item.status === 'cancelled').length),
    totalCount: computed(() => store.items().length),
    hasItems: computed(() => store.items().length > 0),
    /** Description of the currently processing item, or null when queue is idle. */
    currentProcessingDescription: computed(() => {
      const processing = store.items().find(item => item.status === 'processing');
      return processing?.description ?? null;
    }),

    // --- Body-fetch queue computeds ---
    bodyFetchPendingCount: computed(() => store.bodyFetchItems().filter(item => item.status === 'pending').length),
    bodyFetchProcessingCount: computed(() => store.bodyFetchItems().filter(item => item.status === 'processing').length),
    bodyFetchCompletedCount: computed(() => store.bodyFetchItems().filter(item => item.status === 'completed').length),
    bodyFetchFailedCount: computed(() => store.bodyFetchItems().filter(item => item.status === 'failed').length),
    bodyFetchCancelledCount: computed(() => store.bodyFetchItems().filter(item => item.status === 'cancelled').length),
    bodyFetchActiveCount: computed(() =>
      store.bodyFetchItems().filter(item => item.status === 'pending' || item.status === 'processing').length,
    ),

    // --- Combined computeds ---
    /** Total count of pending + processing items across both queues (used for queue status badge). */
    activeCount: computed(() => {
      const mainActive = store.items().filter(item => item.status === 'pending' || item.status === 'processing').length;
      const bodyFetchActive = store.bodyFetchItems().filter(item => item.status === 'pending' || item.status === 'processing').length;
      return mainActive + bodyFetchActive;
    }),
  })),

  withMethods((store) => {
    const electronService = inject(ElectronService);
    const toastService = inject(ToastService);

    return {
      /** Fetch full main queue state from the main process (used on init / refresh). */
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

      /** Fetch full body-fetch queue state from the main process (used on init / refresh). */
      async loadBodyFetchStatus(): Promise<void> {
        try {
          const response = await electronService.getBodyQueueStatus();
          if (response.success && response.data) {
            const bodyFetchItems = response.data as QueueItemSnapshot[];
            patchState(store, { bodyFetchItems });
          }
        } catch {
          // Body-fetch queue load failure is non-critical — silently ignore
        }
      },

      /** Handle a queue:update push event from the main process (main mail queue). */
      handleUpdate(update: QueueItemSnapshot): void {
        const currentItems = [...store.items()];
        const existingIndex = currentItems.findIndex(item => item.queueId === update.queueId);
        const isSyncOp = update.type === 'sync-folder' || update.type === 'sync-thread';

        // Detect status transitions for toast notifications.
        if (existingIndex >= 0) {
          const previousStatus = currentItems[existingIndex].status;
          if (previousStatus !== update.status) {
            // Suppress failure toasts for background sync operations — they are transient
            // and will be retried automatically on the next sync tick.
            if (update.status === 'failed' && !isSyncOp) {
              toastService.error(`${update.description} failed: ${update.error || 'Unknown error'}`);
            } else if (update.status === 'completed' && update.type === 'send') {
              toastService.success('Email sent successfully');
            }
          }
          currentItems[existingIndex] = update;
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

      /** Handle a body-queue:update push event from the main process (body-fetch queue).
       *  Body-fetch failures are transient/silent — no error toasts are emitted.
       */
      handleBodyFetchUpdate(update: QueueItemSnapshot): void {
        const currentItems = [...store.bodyFetchItems()];
        const existingIndex = currentItems.findIndex(item => item.queueId === update.queueId);
        if (existingIndex >= 0) {
          currentItems[existingIndex] = update;
        } else {
          currentItems.push(update);
        }
        patchState(store, { bodyFetchItems: currentItems });
      },

      async retryAll(): Promise<number> {
        const response = await electronService.retryFailedOperations();
        if (response.success && response.data) {
          return (response.data as { retriedCount: number }).retriedCount;
        }
        return 0;
      },

      /* c8 ignore next -- requires failed queue item */
      async retrySingle(queueId: string): Promise<void> {
        await electronService.retryFailedOperations(queueId);
      },

      /** Clear completed/cancelled items from both the main queue and the body-fetch queue.
       *  Uses Promise.allSettled so a partial failure on one queue does not block the other.
       *  Only removes items from the local store for whichever IPC call succeeded — a failed
       *  IPC response leaves that queue's local state intact to avoid a desync.
       */
      async clearCompleted(): Promise<number> {
        const results = await Promise.allSettled([
          electronService.clearCompletedOperations(),
          electronService.clearCompletedBodyQueue(),
        ]);

        let clearedCount = 0;

        const mainResult = results[0];
        const bodyFetchResult = results[1];

        const mainCleared = mainResult.status === 'fulfilled' && mainResult.value.success;
        const bodyFetchCleared = bodyFetchResult.status === 'fulfilled' && bodyFetchResult.value.success;

        if (mainCleared && mainResult.status === 'fulfilled' && mainResult.value.data) {
          clearedCount += (mainResult.value.data as { clearedCount: number }).clearedCount ?? 0;
        }

        // Only patch the local arrays for the queues whose IPC calls succeeded
        if (mainCleared && bodyFetchCleared) {
          patchState(store, {
            items: store.items().filter(item => item.status !== 'completed' && item.status !== 'cancelled'),
            bodyFetchItems: store.bodyFetchItems().filter(item => item.status !== 'completed' && item.status !== 'cancelled' && item.status !== 'failed'),
          });
        } else if (mainCleared) {
          patchState(store, {
            items: store.items().filter(item => item.status !== 'completed' && item.status !== 'cancelled'),
          });
        } else if (bodyFetchCleared) {
          patchState(store, {
            bodyFetchItems: store.bodyFetchItems().filter(item => item.status !== 'completed' && item.status !== 'cancelled' && item.status !== 'failed'),
          });
        }

        return clearedCount;
      },

      /* c8 ignore next -- requires in-progress queue item */
      async cancelOperation(queueId: string): Promise<void> {
        await electronService.cancelOperation(queueId);
      },

      /** Cancel a specific body-fetch queue operation by its queue ID. */
      /* c8 ignore next -- requires in-progress body-fetch item */
      async cancelBodyFetchOperation(queueId: string): Promise<void> {
        await electronService.cancelBodyQueueOperation(queueId);
      },
    };
  }),

  withHooks({
    onInit(store) {
      // Load initial queue state for both queues
      store.loadStatus();
      store.loadBodyFetchStatus();

      // Subscribe to real-time queue updates.
      // QueueStore is providedIn: 'root' (singleton), so these subscriptions
      // live for the app's lifetime — no cleanup needed.
      // ElectronService.onEvent() already wraps callbacks in NgZone.
      const electronService = inject(ElectronService);

      electronService.onEvent<QueueItemSnapshot>('queue:update').subscribe((update) => {
        store.handleUpdate(update);
      });

      electronService.onEvent<QueueItemSnapshot>('body-queue:update').subscribe((update) => {
        store.handleBodyFetchUpdate(update);
      });
    },
  }),
);
