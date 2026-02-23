import { computed, inject } from '@angular/core';
import { Router } from '@angular/router';
import { signalStore, withState, withMethods, withComputed, patchState, withHooks } from '@ngrx/signals';
import { debounceTime } from 'rxjs';
import { ElectronService } from '../core/services/electron.service';
import { MailFetchOlderDonePayload } from '../core/services/electron.service';
import { Thread, Email } from '../core/models/email.model';
import { AccountsStore } from './accounts.store';
import { FoldersStore } from './folders.store';

interface MailFolderUpdatedPayload {
  accountId: number;
  folders: string[];
  reason: 'move' | 'delete' | 'flag' | 'send' | 'draft-create' | 'draft-update' | 'filter' | 'sync' | 'add-labels' | 'remove-labels';
  changeType?: 'new_messages' | 'flag_changes' | 'deletions' | 'mixed';
  count?: number;
}

interface MailNewEmailPayload {
  accountId: number;
  folder: string;
  newEmails: Array<{
    xGmMsgId: string;
    xGmThrid: string;
    sender: string;
    subject: string;
    snippet: string;
  }>;
  totalNewCount: number;
}

interface MailNotificationClickPayload {
  accountId: number;
  xGmThrid: string;
  folder: string;
}

interface MailThreadRefreshPayload {
  accountId: number;
  xGmThrid: string;
  action: 'move' | 'delete';
}

interface EmailsState {
  threads: Thread[];
  selectedThreadId: string | null;
  selectedThread: (Thread & { messages?: Email[] }) | null;
  loading: boolean;
  loadingPage: boolean;
  loadingThread: boolean;
  error: string | null;
  hasMore: boolean;
  currentPage: number;
  syncing: boolean;
  syncProgress: number;
  lastSyncTime: string | null;
  fetchingMore: boolean;
  dbExhausted: boolean;
  fetchError: string | null;
  serverCursorDate: string | null;
  hasLoadedMore: boolean;
  preserveListPosition: boolean;
  // Search state
  searchActive: boolean;
  searchQuery: string | string[] | null;
  searchPhase: 'idle' | 'local' | 'imap' | 'done';
  searchRequestId: string | null;
}

const initialState: EmailsState = {
  threads: [],
  selectedThreadId: null,
  selectedThread: null,
  loading: false,
  loadingPage: false,
  loadingThread: false,
  error: null,
  hasMore: true,
  currentPage: 0,
  syncing: false,
  syncProgress: 0,
  lastSyncTime: null,
  fetchingMore: false,
  dbExhausted: false,
  fetchError: null,
  serverCursorDate: null,
  hasLoadedMore: false,
  preserveListPosition: false,
  // Search state defaults
  searchActive: false,
  searchQuery: null,
  searchPhase: 'idle',
  searchRequestId: null,
};

const PAGE_SIZE = 50;

function getOldestThreadDate(threads: Thread[]): string | null {
  if (threads.length === 0) return null;
  return threads[threads.length - 1].lastMessageDate || null;
}

function isOlderDate(candidate: string, reference: string): boolean {
  const candidateMs = new Date(candidate).getTime();
  const referenceMs = new Date(reference).getTime();
  if (!Number.isFinite(candidateMs) || !Number.isFinite(referenceMs)) return false;
  return candidateMs < referenceMs;
}

export const EmailsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),

  withComputed((store) => {
    // Inject FoldersStore here (top level of withComputed callback) — this runs
    // inside the store constructor where the Angular injection context is available.
    // Do NOT move this inject() call inside the computed() closures below, as those
    // closures run during change detection where injection context is not available.
    const foldersStore = inject(FoldersStore);

    return {
      unreadCount: computed(() =>
        store.threads().filter(t => !t.isRead).length
      ),
      anyLoadingMore: computed(() =>
        store.loadingPage() || store.fetchingMore()
      ),
      selectedMessages: computed(() => {
        const messages = store.selectedThread()?.messages ?? [];
        const activeFolderId = foldersStore.activeFolderId();

        // When viewing the Trash folder, show all messages (including those in Trash)
        if (activeFolderId === '[Gmail]/Trash') {
          return messages;
        }

        // For all other folders (including null during search), hide messages that
        // have been moved to Trash — they should not appear in non-Trash thread views
        return messages.filter(
          m => !m.folders?.includes('[Gmail]/Trash')
        );
      }),
      isEmpty: computed(() =>
        !store.loading() && store.threads().length === 0
      ),
    };
  }),

  withMethods((store) => {
    const electronService = inject(ElectronService);
    const accountsStore = inject(AccountsStore);
    const foldersStore = inject(FoldersStore);

    /** Fetch older emails from IMAP server when local DB is exhausted. Enqueues a fetch-older op; result arrives via mail:fetch-older-done. */
    async function _loadMoreFromServer(accountId: number, folderId: string): Promise<void> {
      if (store.fetchingMore() || !store.hasMore()) {
        return;
      }

      const threads = store.threads();
      const beforeDate = store.serverCursorDate() || getOldestThreadDate(threads);
      if (!beforeDate) {
        patchState(store, { hasMore: false });
        return;
      }

      patchState(store, { fetchingMore: true, fetchError: null });

      try {
        const response = await electronService.fetchOlderEmails(
          String(accountId),
          folderId,
          beforeDate,
          PAGE_SIZE
        );

        if (response.success && response.data && (response.data as { queueId?: string }).queueId) {
          // Enqueued; result will be applied when mail:fetch-older-done fires for this account/folder.
          // Do not patch threads/hasMore here.
        } else {
          patchState(store, {
            fetchingMore: false,
            fetchError: response.error?.message || 'Failed to enqueue fetch older emails',
          });
        }
      } catch (err: unknown) {
        patchState(store, {
          fetchingMore: false,
          fetchError: err instanceof Error ? err.message : 'Failed to fetch older emails from server',
        });
      }
    }

    return {
      /** Load threads for a folder */
      async loadThreads(accountId: number, folderId: string): Promise<void> {
        patchState(store, { loading: true, loadingPage: false, error: null, currentPage: 0, hasMore: true, dbExhausted: false, fetchError: null, serverCursorDate: null, hasLoadedMore: false, preserveListPosition: false });
        try {
          const response = await electronService.fetchEmails(
            String(accountId),
            folderId,
            { limit: PAGE_SIZE, offset: 0 }
          );
          if (response.success && response.data) {
            const threads = response.data as Thread[];
            const dbHasLess = threads.length < PAGE_SIZE;
            patchState(store, {
              threads,
              loading: false,
              // DB having fewer than PAGE_SIZE doesn't mean the server has no more.
              // Keep hasMore=true so scroll-to-load can still trigger server fetch.
              hasMore: true,
              dbExhausted: dbHasLess,
              currentPage: 0,
              serverCursorDate: getOldestThreadDate(threads) ?? (threads.length === 0 ? new Date().toISOString() : null),
              hasLoadedMore: false,
              preserveListPosition: false,
            });

            // If DB is already exhausted on first load, proactively fetch from server (including when folder is empty)
            if (dbHasLess) {
              _loadMoreFromServer(accountId, folderId);
            }
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

      /** Load more threads (pagination) — reads from local DB, then server if DB exhausted */
      async loadMore(accountId: number, folderId: string): Promise<void> {
        if (!store.hasMore() || store.loadingPage() || store.fetchingMore()) return;

        // If DB is already known to be exhausted, go straight to server fetch
        if (store.dbExhausted()) {
          patchState(store, { hasLoadedMore: true, fetchError: null });
          _loadMoreFromServer(accountId, folderId);
          return;
        }

        const nextPage = store.currentPage() + 1;
        patchState(store, { loadingPage: true, fetchError: null, hasLoadedMore: true, preserveListPosition: true });
        try {
          const response = await electronService.fetchEmails(
            String(accountId),
            folderId,
            { limit: PAGE_SIZE, offset: nextPage * PAGE_SIZE }
          );
          if (response.success && response.data) {
            const newThreads = response.data as Thread[];
            const dbHasLess = newThreads.length < PAGE_SIZE;
            patchState(store, {
              threads: [...store.threads(), ...newThreads],
              loadingPage: false,
              currentPage: nextPage,
              dbExhausted: dbHasLess,
              serverCursorDate: getOldestThreadDate([...store.threads(), ...newThreads]),
              hasLoadedMore: true,
            });

            // If DB is exhausted but server may have more, fetch from server
            if (dbHasLess && !store.fetchingMore()) {
              _loadMoreFromServer(accountId, folderId);
            }
          } else {
            const errorMsg = response.error?.message || 'Failed to load more emails';
            patchState(store, {
              loadingPage: false,
              error: errorMsg,
              fetchError: errorMsg,
            });
          }
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : 'Failed to load more emails';
          patchState(store, {
            loadingPage: false,
            error: errorMsg,
            fetchError: errorMsg,
          });
        }
      },

      /** Fetch older emails from IMAP server (public alias for retry UI) */
      loadMoreFromServer: _loadMoreFromServer,

      /** Mark that user has scrolled/interacted with list position. */
      markListScrolled(): void {
        if (!store.preserveListPosition()) {
          patchState(store, { preserveListPosition: true });
        }
      },

      /** Load a full thread with messages. Shows DB cache first if available, then enqueues one sync-thread; reconcile runs on mail:thread-refresh. */
      async loadThread(accountId: number, threadId: string): Promise<void> {
        patchState(store, {
          loadingThread: true,
          selectedThreadId: threadId,
          selectedThread: store.selectedThreadId() === threadId ? store.selectedThread() : null,
          error: null,
        });
        const accountIdStr = String(accountId);

        // Show DB data immediately if we have it (instant display).
        // Only clear loadingThread when messages have actual body content;
        // if all bodies are empty the user would see a hollow shell, so keep
        // the spinner visible and let the server fetch fill everything in.
        try {
          const dbResponse = await electronService.getThreadFromDb(accountIdStr, threadId);
          if (dbResponse.success && dbResponse.data) {
            const threadFromDb = dbResponse.data as Thread & { messages?: Email[] };
            const messages = threadFromDb.messages ?? [];
            const hasContent = messages.length > 0 && messages.some(m => m.htmlBody || m.textBody);
            if (store.selectedThreadId() === threadId && hasContent) {
              // Compute folder-aware visible message count for the list badge.
              // When viewing Trash, show total count; otherwise exclude trashed messages.
              const activeFolderId = foldersStore.activeFolderId();
              const visibleMessages = activeFolderId === '[Gmail]/Trash'
                ? messages
                : messages.filter(m => !m.folders?.includes('[Gmail]/Trash'));
              const visibleCount = visibleMessages.length;

              const updatedThreads = store.threads().map((t) =>
                t.xGmThrid === threadId ? { ...t, messageCount: visibleCount } : t
              );
              patchState(store, { selectedThread: threadFromDb, loadingThread: false, threads: updatedThreads });
            }
          }
        } catch {
          // Non-fatal: we will fetch from server next
        }

        // Enqueue sync-thread so main process fetches bodies and reconciles; reconcile runs on mail:thread-refresh.
        try {
          await electronService.fetchThread(accountIdStr, threadId, true);
        } catch (err: unknown) {
          if (store.selectedThreadId() === threadId) {
            patchState(store, {
              loadingThread: false,
              error: err instanceof Error ? err.message : 'Failed to load thread',
            });
          }
        }
      },

      /** Reconcile thread from DB only (no enqueue). Called when a sync-thread queue item completes (mail:thread-refresh). */
      async reconcileThreadFromDb(accountId: number, threadId: string): Promise<void> {
        const accountIdStr = String(accountId);
        const activeFolderId = foldersStore.activeFolderId();
        try {
          const dbResponse = await electronService.getThreadFromDb(accountIdStr, threadId, activeFolderId ?? undefined);
          if (!dbResponse.success || !dbResponse.data) {
            if (store.selectedThreadId() === threadId) {
              patchState(store, {
                loadingThread: false,
                error: dbResponse.error?.message ?? 'Failed to load thread',
              });
            }
            return;
          }
          const thread = dbResponse.data as Thread & { messages?: Email[] };
          if (store.selectedThreadId() === threadId) {
            patchState(store, {
              selectedThread: thread,
              loadingThread: false,
              error: null,
            });
          }
          // Response has same list-row shape as folder fetch when folderId was passed; reuse for list update.
          const { messages: _m, ...listRow } = thread;
          const updatedThreads = store.threads().map((t) =>
            t.xGmThrid === threadId ? { ...t, ...listRow } : t
          );
          patchState(store, { threads: updatedThreads });
        } catch (err: unknown) {
          if (store.selectedThreadId() === threadId) {
            patchState(store, {
              loadingThread: false,
              error: err instanceof Error ? err.message : 'Failed to load thread',
            });
          }
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
        // Optimistic update — patch both `threads` list AND `selectedThread`
        const targetThreadId = threadId || store.selectedThreadId() || null;
        const selectedThread = store.selectedThread();
        const selectedMatches = selectedThread && selectedThread.xGmThrid === targetThreadId;

        if (flag === 'read') {
          patchState(store, {
            threads: store.threads().map(t =>
              t.xGmThrid === targetThreadId ? { ...t, isRead: value } : t
            ),
            ...(selectedMatches ? { selectedThread: { ...selectedThread, isRead: value } } : {}),
          });
        } else if (flag === 'starred') {
          const activeFolderId = foldersStore.activeFolderId();
          if (!value && activeFolderId === '[Gmail]/Starred') {
            // Unstarring while viewing Starred → optimistically remove thread from list
            patchState(store, {
              threads: store.threads().filter(t => t.xGmThrid !== targetThreadId),
            });
          } else {
            patchState(store, {
              threads: store.threads().map(t =>
                t.xGmThrid === targetThreadId ? { ...t, isStarred: value } : t
              ),
              ...(selectedMatches ? { selectedThread: { ...selectedThread, isStarred: value } } : {}),
            });
          }
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

      /** Move emails to a folder.
       *  When `perMessageGmailId` is provided, only that message is removed from
       *  the selected thread's message list (per-message move/delete).
       *  Otherwise the entire thread is removed from the threads list (thread-level). */
      async moveEmails(
        accountId: number,
        messageIds: string[],
        targetFolder: string,
        threadId?: string,
        sourceFolder?: string,
        perMessageGmailId?: string
      ): Promise<void> {
        const targetThreadId = threadId || store.selectedThreadId() || null;

        if (perMessageGmailId) {
          // Per-message move: remove the specific message from the selected thread
          const selectedThread = store.selectedThread();
          if (selectedThread && selectedThread.xGmThrid === targetThreadId && selectedThread.messages) {
            const updatedMessages = selectedThread.messages.filter(
              m => m.xGmMsgId !== perMessageGmailId
            );
            if (updatedMessages.length === 0) {
              // Last message in thread — remove thread from list and clear selection
              patchState(store, {
                threads: store.threads().filter(t => t.xGmThrid !== targetThreadId),
                selectedThread: null,
                selectedThreadId: null,
              });
            } else {
              patchState(store, {
                selectedThread: {
                  ...selectedThread,
                  messages: updatedMessages,
                  messageCount: updatedMessages.length,
                },
              });
            }
          }
        } else {
          // Thread-level move: remove the entire thread from the list
          patchState(store, {
            threads: store.threads().filter(t => t.xGmThrid !== targetThreadId),
            selectedThread: null,
            selectedThreadId: null,
          });
        }

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
          threads: store.threads().filter(t => t.xGmThrid !== targetThreadId),
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

      /**
       * Add labels to emails — enqueues an add-labels queue operation.
       * UIDs are resolved at enqueue time via the IPC handler on the backend.
       */
      async addLabels(
        accountId: number,
        xGmMsgIds: string[],
        targetLabels: string[],
        threadId: string
      ): Promise<void> {
        try {
          const response = await electronService.enqueueOperation({
            type: 'add-labels',
            accountId,
            payload: { xGmMsgIds, targetLabels, threadId, resolvedEmails: [] },
            description: `Add ${targetLabels.length} label(s) to ${xGmMsgIds.length} message(s)`,
          });
          if (!response.success) {
            patchState(store, { error: response.error?.message || 'Failed to add labels' });
          }
        } catch (err: unknown) {
          patchState(store, { error: err instanceof Error ? err.message : 'Failed to add labels' });
        }
      },

      /**
       * Remove labels from emails — enqueues a remove-labels queue operation.
       * UIDs are resolved at enqueue time via the IPC handler on the backend.
       */
      async removeLabels(
        accountId: number,
        xGmMsgIds: string[],
        targetLabels: string[],
        threadId: string
      ): Promise<void> {
        try {
          const response = await electronService.enqueueOperation({
            type: 'remove-labels',
            accountId,
            payload: { xGmMsgIds, targetLabels, threadId, resolvedEmails: [] },
            description: `Remove ${targetLabels.length} label(s) from ${xGmMsgIds.length} message(s)`,
          });
          if (!response.success) {
            patchState(store, { error: response.error?.message || 'Failed to remove labels' });
          }
        } catch (err: unknown) {
          patchState(store, { error: err instanceof Error ? err.message : 'Failed to remove labels' });
        }
      },

      /**
       * Two-phase progressive search:
       * Phase 1: Local DB search (immediate results)
       * Phase 2: IMAP search (background, merges progressively)
       */
      async searchEmails(accountId: number, query: string | string[]): Promise<void> {
        const requestId = crypto.randomUUID();
        patchState(store, {
          loading: true,
          error: null,
          searchActive: true,
          searchQuery: query,
          searchPhase: 'local',
          searchRequestId: requestId,
          hasMore: false,
          hasLoadedMore: false,
          preserveListPosition: false,
        });

        // Phase 1: Local DB search
        try {
          const response = await electronService.searchEmails(String(accountId), query);
          if (response.success && response.data) {
            const results = response.data as Thread[];
            patchState(store, {
              threads: results,
              loading: false,
            });
            // Update folder store with result count
            foldersStore.updateSearchResultCount(results.length);
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

        // Phase 2: IMAP search (background)
        patchState(store, { searchPhase: 'imap' });
        foldersStore.setSearchingImap(true);

        try {
          const imapResponse = await electronService.searchImapEmails(String(accountId), query);

          // Check if this search is still active (user may have started a new one)
          if (store.searchRequestId() !== requestId) {
            return; // Stale result — discard
          }

          if (imapResponse.success && imapResponse.data) {
            const imapData = imapResponse.data as { threads: Thread[]; resultCount: number };
            const imapThreads = imapData.threads || [];

            if (imapThreads.length > 0) {
              // Deduplicate: build set of existing xGmThrids
              const existingIds = new Set(store.threads().map(t => t.xGmThrid));
              const newThreads = imapThreads.filter(t => !existingIds.has(t.xGmThrid));

              if (newThreads.length > 0) {
                // Merge and sort by date descending
                const merged = [...store.threads(), ...newThreads].sort(
                  (a, b) => new Date(b.lastMessageDate).getTime() - new Date(a.lastMessageDate).getTime()
                );
                patchState(store, { threads: merged });
                foldersStore.updateSearchResultCount(merged.length);
              }
            }

            foldersStore.setSearchingImap(false);
          } else {
            // IMAP response was unsuccessful — treat as error
            const errorMessage = imapResponse.error?.message || 'IMAP search failed';
            foldersStore.setSearchImapError(errorMessage);
          }

          patchState(store, { searchPhase: 'done' });
        } catch (err: unknown) {
          // Check if still active before updating state
          if (store.searchRequestId() !== requestId) {
            return;
          }
          const errorMessage = err instanceof Error ? err.message : 'IMAP search failed';
          foldersStore.setSearchImapError(errorMessage);
          patchState(store, { searchPhase: 'done' });
          // Local results remain displayed — IMAP failure is non-fatal
        }
      },

      /** Clear search state */
      clearSearch(): void {
        patchState(store, {
          searchActive: false,
          searchQuery: null,
          searchPhase: 'idle',
          searchRequestId: null,
        });
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
       * If the user has loaded beyond the initial page (DB or server pagination),
       * merges new/updated threads into the existing list instead of replacing it,
       * to preserve virtual-scroll position.
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
            const preserveScrolledList =
              store.preserveListPosition() ||
              store.hasLoadedMore() ||
              store.currentPage() > 0;

            if (preserveScrolledList) {
              // User has scrolled or loaded additional pages — merge instead of replace to
              // preserve virtual-scroll position. Strategy: ID-based diff.
              //   • Deletions: existing threads whose IDs should have appeared in the fresh
              //     first-page query but didn't (confirmed removed on server).
              //   • Additions: fresh threads not present in the existing list (new arrivals).
              //   • Updates: threads in both sets get flags/snippet/messageCount refreshed.
              const existingThreads = store.threads();

              // Build ID sets for O(1) lookups
              const freshIdSet = new Set(freshThreads.map(t => t.xGmThrid));
              const existingIdSet = new Set(existingThreads.map(t => t.xGmThrid));

              // Build a lookup map for fresh thread data (for updating existing threads)
              const freshMap = new Map(freshThreads.map(t => [t.xGmThrid, t]));

              // Determine if the folder has shrunk below a single page.
              // If so, every existing thread absent from fresh data is a confirmed deletion.
              const folderShrunkBelowPage = freshThreads.length < PAGE_SIZE;

              // Date boundary: oldest lastMessageDate among fresh threads.
              // Existing threads with a date strictly NEWER than this boundary should have
              // appeared in the first-page query — if they're absent, they were deleted.
              // Threads at or older than the boundary may be paginated below the fold — keep them.
              const boundary =
                freshThreads.length > 0
                  ? new Date(freshThreads[freshThreads.length - 1].lastMessageDate).getTime()
                  : null;

              // Step 1: Filter existing threads — remove confirmed deletions, update kept ones
              const filteredExisting = existingThreads
                .filter(t => {
                  if (freshIdSet.has(t.xGmThrid)) {
                    return true; // Present in fresh data — always keep
                  }
                  if (folderShrunkBelowPage) {
                    return false; // Folder shrank below one page — all absences are deletions
                  }
                  if (boundary === null) {
                    return true; // No fresh threads, can't determine boundary — keep
                  }
                  // Only remove if the thread's date is strictly newer than the boundary.
                  // Threads at exactly the boundary date are ties — err on the side of keeping.
                  const threadDate = t.lastMessageDate
                    ? new Date(t.lastMessageDate).getTime()
                    : 0;
                  return threadDate <= boundary; // Keep paginated threads and boundary ties
                })
                .map(t => {
                  const fresh = freshMap.get(t.xGmThrid);
                  return fresh
                    ? { ...t, isRead: fresh.isRead, isStarred: fresh.isStarred, snippet: fresh.snippet, messageCount: fresh.messageCount }
                    : t;
                });

              // Step 2: Identify new arrivals — prepend them so they appear above current view
              const newThreads = freshThreads.filter(t => !existingIdSet.has(t.xGmThrid));

              // Step 3: Assemble merged list: new arrivals first, then updated/filtered existing
              const mergedThreads = [...newThreads, ...filteredExisting];

              // Step 4: Clear selection if the selected thread was deleted
              const selectedStillExists = currentSelectedId
                ? mergedThreads.some(t => t.xGmThrid === currentSelectedId)
                : true;

              // Step 5: Update serverCursorDate to the oldest thread in the merged list
              const newCursorDate = getOldestThreadDate(mergedThreads);

              patchState(store, {
                threads: mergedThreads,
                dbExhausted: folderShrunkBelowPage,
                serverCursorDate: newCursorDate || store.serverCursorDate(),
                ...(currentSelectedId && !selectedStillExists
                  ? { selectedThreadId: null, selectedThread: null }
                  : {}),
              });
            } else {
              // User on first page — replace normally
              const selectedStillExists = currentSelectedId
                ? freshThreads.some(t => t.xGmThrid === currentSelectedId)
                : false;

              patchState(store, {
                threads: freshThreads,
                hasMore: true,
                dbExhausted: freshThreads.length < PAGE_SIZE,
                currentPage: 0,
                serverCursorDate: getOldestThreadDate(freshThreads),
                hasLoadedMore: false,
                preserveListPosition: false,
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
      const router = inject(Router);

      // Subscribe to mail:folder-updated events from the main process.
      // Refresh folder counts (so sidebar unread matches Gmail) and threads when the active folder's data has changed.
      electronService
        .onEvent<MailFolderUpdatedPayload>('mail:folder-updated')
        .pipe(debounceTime(500))
        .subscribe((event) => {
        const activeAccountId = accountsStore.activeAccountId();
        const activeFolderId = foldersStore.activeFolderId();

        // Refresh folder list so unread/total counts in sidebar match server after flag/move/delete
        if (activeAccountId != null && event.accountId === activeAccountId) {
          foldersStore.loadFolders(activeAccountId);
        }

        // Flag updates are already applied optimistically in the renderer.
        // Skipping refresh here avoids unnecessary list churn/jumps when opening unread.
        // EXCEPTION: [Gmail]/Starred folder membership changes on star/unstar flag ops,
        // so we must refresh when viewing Starred or when the event touches Starred.
        if (event.reason === 'flag') {
          const isStarredView = activeFolderId === '[Gmail]/Starred';
          const eventTouchesStarred = event.folders.includes('[Gmail]/Starred');
          if (isStarredView && activeAccountId != null && event.accountId === activeAccountId) {
            // Viewing Starred — always refresh on flag events from same account
            store.refreshThreads();
            return;
          }
          if (!eventTouchesStarred) {
            return;
          }
          // Fall through to refresh for flag changes that touch Starred while viewing another folder
          // (e.g., user stars from INBOX — if Starred is somehow the active view this won't fire,
          //  but the above block catches that case already)
        }

        const sameAccount = activeAccountId != null && event.accountId === activeAccountId;
        const touchesActiveFolder = activeFolderId != null && event.folders.includes(activeFolderId);

        if (sameAccount && touchesActiveFolder) {
          store.refreshThreads();
        }

        // Reload the open thread whenever an operation mutates its messages.
        // draft-update always emits [Gmail]/Drafts so it never matches touchesActiveFolder
        // when viewing INBOX; delete/move/send do touch the active folder but also need
        // the thread messages refreshed, not just the list.
        const messagesMutatingReasons: MailFolderUpdatedPayload['reason'][] = [
          'draft-create', 'draft-update', 'delete', 'move', 'send',
        ];
        if (sameAccount && messagesMutatingReasons.includes(event.reason)) {
          const selectedId = store.selectedThreadId();
          if (selectedId) {
            store.loadThread(activeAccountId!, selectedId);
          }
        }
        });

      // Subscribe to mail:new-email events (IDLE push notifications).
      // Refresh threads if active folder matches; always refresh folder unread counts.
      electronService.onEvent<MailNewEmailPayload>('mail:new-email').subscribe((event) => {
        const activeAccountId = accountsStore.activeAccountId();
        const activeFolderId = foldersStore.activeFolderId();

        // Always refresh folder unread counts when new emails arrive
        if (activeAccountId != null && event.accountId === activeAccountId) {
          foldersStore.loadFolders(activeAccountId);
        }

        // Refresh thread list if we're viewing the folder that received new mail
        if (
          activeAccountId != null &&
          event.accountId === activeAccountId &&
          activeFolderId != null &&
          event.folder === activeFolderId
        ) {
          store.refreshThreads();
        }
      });

      // Subscribe to mail:thread-refresh events from the queue worker.
      // After a move/delete is confirmed server-side, re-load the selected thread
      // if it matches the event's xGmThrid so the UI reflects the clean DB state.
      electronService.onEvent<MailThreadRefreshPayload>('mail:thread-refresh').subscribe(async (event) => {
        const activeAccountId = accountsStore.activeAccountId();
        if (activeAccountId == null || event.accountId !== activeAccountId) {
          return;
        }
        const selectedThreadId = store.selectedThreadId();
        if (selectedThreadId === event.xGmThrid) {
          // Reconcile from DB only (queue item already processed; no enqueue).
          await store.reconcileThreadFromDb(event.accountId, event.xGmThrid);
        }
      });

      // Subscribe to mail:fetch-older-done (scroll-to-load result from queue worker).
      electronService.onFetchOlderDone().subscribe((payload: MailFetchOlderDonePayload) => {
        const activeAccountId = accountsStore.activeAccountId();
        const activeFolderId = foldersStore.activeFolderId();
        if (activeAccountId == null || payload.accountId !== activeAccountId || activeFolderId !== payload.folderId) {
          return;
        }
        if (payload.error) {
          patchState(store, { fetchingMore: false, fetchError: payload.error });
          return;
        }
        const newThreads = ((payload.threads ?? []) as unknown) as Thread[];
        const existingIds = new Set(store.threads().map((t) => t.xGmThrid));
        const deduped = newThreads.filter((t) => !existingIds.has(t.xGmThrid));
        const nextCursorDate = payload.nextBeforeDate ?? store.serverCursorDate();
        const beforeDate = store.serverCursorDate();
        const cursorAdvanced = beforeDate ? isOlderDate(nextCursorDate ?? beforeDate, beforeDate) : true;
        const hasMore = (payload.hasMore ?? false) && (deduped.length > 0 || cursorAdvanced);
        patchState(store, {
          threads: [...store.threads(), ...deduped],
          fetchingMore: false,
          hasMore,
          serverCursorDate: nextCursorDate ?? null,
          hasLoadedMore: store.hasLoadedMore() || deduped.length > 0,
        });
      });

      // Subscribe to mail:notification-click events.
      // Perform store operations first, then navigate cross-view if needed.
      electronService.onEvent<MailNotificationClickPayload>('mail:notification-click').subscribe(async (event) => {
        try {
          // 1. Ensure accounts are loaded
          await accountsStore.loadAccounts();

          // 2. Set active account
          accountsStore.setActiveAccount(event.accountId);

          // 3. Load folders for the target account
          await foldersStore.loadFolders(event.accountId);

          // 4. Set active folder
          foldersStore.setActiveFolder(event.folder);

          // 5. Load threads for the target folder
          await store.loadThreads(event.accountId, event.folder);

          // 6. Load the specific thread if provided
          if (event.xGmThrid) {
            await store.loadThread(event.accountId, event.xGmThrid);
          }

          // 7. Cross-view navigation: only navigate if not already on the mail view
          if (!router.url.startsWith('/mail')) {
            router.navigate(['/mail']);
          }
        } catch (err: unknown) {
          // Failures are reflected in individual store error states.
          // No toast or retry needed — user can manually navigate.
          console.error('Notification click handler failed:', err);
        }
      });
    },
  }),
);
