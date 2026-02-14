import { computed, inject } from '@angular/core';
import { signalStore, withState, withMethods, withComputed, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { Thread, Email } from '../core/models/email.model';

interface EmailsState {
  threads: Thread[];
  selectedThreadId: string | null;
  selectedThread: (Thread & { messages?: Email[] }) | null;
  loading: boolean;
  loadingThread: boolean;
  error: string | null;
  hasMore: boolean;
  currentPage: number;
  syncing: boolean;
  syncProgress: number;
}

const initialState: EmailsState = {
  threads: [],
  selectedThreadId: null,
  selectedThread: null,
  loading: false,
  loadingThread: false,
  error: null,
  hasMore: true,
  currentPage: 0,
  syncing: false,
  syncProgress: 0,
};

const PAGE_SIZE = 50;

export const EmailsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),

  withComputed((store) => ({
    unreadCount: computed(() =>
      store.threads().filter(t => !t.isRead).length
    ),
    selectedMessages: computed(() =>
      store.selectedThread()?.messages ?? []
    ),
    isEmpty: computed(() =>
      !store.loading() && store.threads().length === 0
    ),
  })),

  withMethods((store) => {
    const electronService = inject(ElectronService);

    return {
      /** Load threads for a folder */
      async loadThreads(accountId: number, folderId: string): Promise<void> {
        patchState(store, { loading: true, error: null, currentPage: 0, hasMore: true });
        try {
          const response = await electronService.fetchEmails(
            String(accountId),
            folderId,
            { limit: PAGE_SIZE, offset: 0 }
          );
          if (response.success && response.data) {
            const threads = response.data as Thread[];
            patchState(store, {
              threads,
              loading: false,
              hasMore: threads.length >= PAGE_SIZE,
              currentPage: 0,
            });
          } else {
            patchState(store, {
              loading: false,
              error: response.error?.message || 'Failed to load emails',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load emails',
          });
        }
      },

      /** Load more threads (pagination) */
      async loadMore(accountId: number, folderId: string): Promise<void> {
        if (!store.hasMore() || store.loading()) return;

        const nextPage = store.currentPage() + 1;
        patchState(store, { loading: true });
        try {
          const response = await electronService.fetchEmails(
            String(accountId),
            folderId,
            { limit: PAGE_SIZE, offset: nextPage * PAGE_SIZE }
          );
          if (response.success && response.data) {
            const newThreads = response.data as Thread[];
            patchState(store, {
              threads: [...store.threads(), ...newThreads],
              loading: false,
              hasMore: newThreads.length >= PAGE_SIZE,
              currentPage: nextPage,
            });
          } else {
            patchState(store, { loading: false });
          }
        } catch {
          patchState(store, { loading: false });
        }
      },

      /** Load a full thread with messages */
      async loadThread(accountId: number, threadId: string): Promise<void> {
        patchState(store, { loadingThread: true, selectedThreadId: threadId });
        try {
          const response = await electronService.fetchThread(String(accountId), threadId);
          if (response.success && response.data) {
            const thread = response.data as Thread & { messages?: Email[] };
            patchState(store, {
              selectedThread: thread,
              loadingThread: false,
            });
          } else {
            patchState(store, {
              loadingThread: false,
              error: response.error?.message || 'Failed to load thread',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            loadingThread: false,
            error: err instanceof Error ? err.message : 'Failed to load thread',
          });
        }
      },

      /** Select a thread by ID */
      selectThread(threadId: string | null): void {
        patchState(store, { selectedThreadId: threadId, selectedThread: null });
      },

      /** Toggle flag on emails */
      async flagEmails(
        accountId: number,
        messageIds: string[],
        flag: string,
        value: boolean
      ): Promise<void> {
        // Optimistic update
        if (flag === 'read') {
          patchState(store, {
            threads: store.threads().map(t =>
              messageIds.includes(t.gmailThreadId) ? { ...t, isRead: value } : t
            ),
          });
        } else if (flag === 'starred') {
          patchState(store, {
            threads: store.threads().map(t =>
              messageIds.includes(t.gmailThreadId) ? { ...t, isStarred: value } : t
            ),
          });
        }

        try {
          await electronService.flagEmails(String(accountId), messageIds, flag, value);
        } catch (err) {
          // Revert on failure — reload threads
        }
      },

      /** Move emails to a folder */
      async moveEmails(
        accountId: number,
        messageIds: string[],
        targetFolder: string
      ): Promise<void> {
        // Optimistic remove from list
        patchState(store, {
          threads: store.threads().filter(t => !messageIds.includes(t.gmailThreadId)),
        });

        try {
          await electronService.moveEmails(String(accountId), messageIds, targetFolder);
        } catch (err) {
          // On failure, we'd need to reload
        }
      },

      /** Search emails */
      async searchEmails(accountId: number, query: string): Promise<void> {
        patchState(store, { loading: true, error: null });
        try {
          const response = await electronService.searchEmails(String(accountId), query);
          if (response.success && response.data) {
            const results = response.data as Thread[];
            patchState(store, { threads: results, loading: false, hasMore: false });
          } else {
            patchState(store, { loading: false });
          }
        } catch {
          patchState(store, { loading: false });
        }
      },

      /** Trigger sync for an account */
      async syncAccount(accountId: number): Promise<void> {
        patchState(store, { syncing: true, syncProgress: 0 });
        try {
          await electronService.syncAccount(String(accountId));
          patchState(store, { syncing: false, syncProgress: 100 });
        } catch {
          patchState(store, { syncing: false });
        }
      },

      /** Update sync progress (called from sync events) */
      updateSyncProgress(progress: number): void {
        patchState(store, { syncProgress: progress, syncing: progress < 100 });
      },

      /** Clear selection */
      clearSelection(): void {
        patchState(store, { selectedThreadId: null, selectedThread: null });
      },

      /** Clear all state */
      clearAll(): void {
        patchState(store, initialState);
      },
    };
  })
);
