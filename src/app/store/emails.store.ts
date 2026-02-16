import { computed, inject } from '@angular/core';
import { signalStore, withState, withMethods, withComputed, patchState, withHooks } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { Thread, Email } from '../core/models/email.model';
import { AccountsStore } from './accounts.store';
import { FoldersStore } from './folders.store';

interface MailDataChangedPayload {
  accountId: number;
  folders: string[];
  reason: 'move' | 'delete' | 'flag' | 'send' | 'draft-create' | 'draft-update';
}

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
  lastSyncTime: string | null;
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
  lastSyncTime: null,
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
    const accountsStore = inject(AccountsStore);
    const foldersStore = inject(FoldersStore);

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
            patchState(store, {
              loading: false,
              error: response.error?.message || 'Failed to load more emails',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load more emails',
          });
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
        value: boolean,
        threadId?: string
      ): Promise<void> {
        // Optimistic update
        const targetThreadId = threadId || store.selectedThreadId() || null;
        if (flag === 'read') {
          patchState(store, {
            threads: store.threads().map(t =>
              t.gmailThreadId === targetThreadId ? { ...t, isRead: value } : t
            ),
          });
        } else if (flag === 'starred') {
          patchState(store, {
            threads: store.threads().map(t =>
              t.gmailThreadId === targetThreadId ? { ...t, isStarred: value } : t
            ),
          });
        }

        try {
          const response = await electronService.flagEmails(String(accountId), messageIds, flag, value);
          if (!response.success) {
            patchState(store, {
              error: response.error?.message || 'Failed to update flags',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            error: err instanceof Error ? err.message : 'Failed to update flags',
          });
        }
      },

      /** Move emails to a folder */
      async moveEmails(
        accountId: number,
        messageIds: string[],
        targetFolder: string,
        threadId?: string,
        sourceFolder?: string
      ): Promise<void> {
        // Optimistic remove from list
        const targetThreadId = threadId || store.selectedThreadId() || null;
        patchState(store, {
          threads: store.threads().filter(t => t.gmailThreadId !== targetThreadId),
        });

        try {
          const response = await electronService.moveEmails(String(accountId), messageIds, targetFolder, sourceFolder);
          if (!response.success) {
            patchState(store, {
              error: response.error?.message || 'Failed to move emails',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            error: err instanceof Error ? err.message : 'Failed to move emails',
          });
        }
      },

      /** Delete emails from a folder */
      async deleteEmails(
        accountId: number,
        messageIds: string[],
        folder: string,
        threadId?: string,
      ): Promise<void> {
        // Optimistic remove from list
        const targetThreadId = threadId || store.selectedThreadId() || null;
        patchState(store, {
          threads: store.threads().filter(t => t.gmailThreadId !== targetThreadId),
        });

        try {
          const response = await electronService.deleteEmails(String(accountId), messageIds, folder);
          if (!response.success) {
            patchState(store, {
              error: response.error?.message || 'Failed to delete emails',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            error: err instanceof Error ? err.message : 'Failed to delete emails',
          });
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
            patchState(store, {
              loading: false,
              error: response.error?.message || 'Search failed',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            loading: false,
            error: err instanceof Error ? err.message : 'Search failed',
          });
        }
      },

      /** Trigger sync for an account */
      async syncAccount(accountId: number): Promise<void> {
        patchState(store, { syncing: true, syncProgress: 0 });
        try {
          const response = await electronService.syncAccount(String(accountId));
          if (response.success) {
            patchState(store, {
              syncing: false,
              syncProgress: 100,
              lastSyncTime: new Date().toISOString(),
            });
          } else {
            patchState(store, {
              syncing: false,
              error: response.error?.message || 'Sync failed',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            syncing: false,
            error: err instanceof Error ? err.message : 'Sync failed',
          });
        }
      },

      /** Update sync progress (called from sync events) */
      updateSyncProgress(progress: number): void {
        const isDone = progress >= 100;
        patchState(store, {
          syncProgress: progress,
          syncing: !isDone,
          // Set lastSyncTime whenever sync completes (via progress event from main process)
          ...(isDone ? { lastSyncTime: new Date().toISOString() } : {}),
        });
      },

      /** Clear selection */
      clearSelection(): void {
        patchState(store, { selectedThreadId: null, selectedThread: null });
      },

      /** Clear all state */
      clearAll(): void {
        patchState(store, initialState);
      },

      /**
       * Background refresh of thread list for the active folder.
       * Does NOT set loading=true (no spinner — this is a background refresh).
       * Preserves selection when possible; clears if selected thread no longer exists.
       *
       * If the user has scrolled past page 0 (currentPage > 0), merges new/updated
       * threads into the existing list instead of replacing it, to preserve scroll position.
       */
      async refreshThreads(): Promise<void> {
        const accountId = accountsStore.activeAccountId();
        const folderId = foldersStore.activeFolderId();
        if (!accountId || !folderId) return;

        try {
          const response = await electronService.fetchEmails(
            String(accountId),
            folderId,
            { limit: PAGE_SIZE, offset: 0 }
          );

          // Re-check active context — user may have navigated away during fetch
          if (accountsStore.activeAccountId() !== accountId || foldersStore.activeFolderId() !== folderId) {
            return;
          }

          if (response.success && response.data) {
            const freshThreads = response.data as Thread[];
            const currentSelectedId = store.selectedThreadId();

            if (store.currentPage() > 0) {
              // User has scrolled — merge instead of replace to preserve scroll position.
              // Prepend genuinely new threads, update existing ones in-place.
              const existingThreads = store.threads();
              const existingIds = new Set(existingThreads.map(t => t.gmailThreadId));

              // Threads in fresh data not present in current list → new arrivals
              const newThreads = freshThreads.filter(t => !existingIds.has(t.gmailThreadId));

              // Build a lookup for fresh data to update flags (read/starred) on existing threads
              const freshMap = new Map(freshThreads.map(t => [t.gmailThreadId, t]));

              const updatedExisting = existingThreads.map(t => {
                const fresh = freshMap.get(t.gmailThreadId);
                return fresh ? { ...t, isRead: fresh.isRead, isStarred: fresh.isStarred, snippet: fresh.snippet, messageCount: fresh.messageCount } : t;
              });

              const mergedThreads = [...newThreads, ...updatedExisting];

              patchState(store, { threads: mergedThreads });
            } else {
              // User on first page — replace normally
              const selectedStillExists = currentSelectedId
                ? freshThreads.some(t => t.gmailThreadId === currentSelectedId)
                : false;

              patchState(store, {
                threads: freshThreads,
                hasMore: freshThreads.length >= PAGE_SIZE,
                currentPage: 0,
                // Clear selection if the selected thread no longer exists in the refreshed list
                ...(currentSelectedId && !selectedStillExists
                  ? { selectedThreadId: null, selectedThread: null }
                  : {}),
              });
            }
          }
        } catch {
          // Best-effort refresh — failures are silently ignored
        }
      },

    };
  }),

  withHooks({
    onInit(store) {
      // withHooks.onInit runs in injection context — inject() works here
      const electronService = inject(ElectronService);
      const accountsStore = inject(AccountsStore);
      const foldersStore = inject(FoldersStore);

      // Subscribe to mail:data-changed events from the main process.
      // Refresh threads when the active folder's data has changed.
      electronService.onEvent<MailDataChangedPayload>('mail:data-changed').subscribe((event) => {
        const activeAccountId = accountsStore.activeAccountId();
        const activeFolderId = foldersStore.activeFolderId();

        if (
          activeAccountId != null &&
          event.accountId === activeAccountId &&
          activeFolderId != null &&
          event.folders.includes(activeFolderId)
        ) {
          store.refreshThreads();
        }
      });
    },
  }),
);
