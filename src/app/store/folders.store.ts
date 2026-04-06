import { computed, inject } from '@angular/core';
import { signalStore, withState, withMethods, withComputed, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { Folder } from '../core/models/account.model';

interface FoldersState {
  folders: Folder[];
  activeFolderId: string | null;
  loading: boolean;
  error: string | null;
  // Search state
  searchActive: boolean;
  searchQuery: string | null;
  searchDisplayQuery: string | null;
  searchResultCount: number;
  searchingImap: boolean;
  searchImapError: string | null;
  previousFolderId: string | null;
}

const initialState: FoldersState = {
  folders: [],
  activeFolderId: null,
  loading: false,
  error: null,
  // Search state defaults
  searchActive: false,
  searchQuery: null,
  searchDisplayQuery: null,
  searchResultCount: 0,
  searchingImap: false,
  searchImapError: null,
  previousFolderId: null,
};

/** Map Gmail special-use paths to icons (keyed by gmailLabelId) */
const FOLDER_ICON_MAP: Record<string, string> = {
  'INBOX': 'inbox',
  '[Gmail]/Sent Mail': 'send',
  '[Gmail]/Drafts': 'edit_note',
  '[Gmail]/Trash': 'delete',
  '[Gmail]/Spam': 'report',
  '[Gmail]/Starred': 'star',
};

/** Fallback icon map keyed by RFC 6154 specialUse attribute (for locale-variant folder names) */
const SPECIAL_USE_ICON_MAP: Record<string, string> = {
  '\\Inbox': 'inbox',
  '\\Sent': 'send',
  '\\Drafts': 'edit_note',
  '\\Trash': 'delete',
  '\\Junk': 'report',
  '\\Flagged': 'star',
};

const SYSTEM_FOLDER_ORDER: Record<string, number> = {
  'INBOX': 0,
  '[Gmail]/Starred': 1,
  '[Gmail]/Drafts': 2,
  '[Gmail]/Sent Mail': 3,
  '[Gmail]/Spam': 4,
  '[Gmail]/Trash': 5,
};

/** Fallback ordering by RFC 6154 specialUse attribute (for locale-variant folder names) */
const SPECIAL_USE_ORDER: Record<string, number> = {
  '\\Inbox': 0,
  '\\Flagged': 1,
  '\\Drafts': 2,
  '\\Sent': 3,
  '\\Junk': 4,
  '\\Trash': 5,
};

function isRecognizedSystemFolder(folder: Pick<Folder, 'gmailLabelId' | 'specialUse'>): boolean {
  if (folder.specialUse && SPECIAL_USE_ORDER[folder.specialUse] !== undefined) {
    return true;
  }

  return SYSTEM_FOLDER_ORDER[folder.gmailLabelId] !== undefined;
}

function compareSystemFolders(a: Folder, b: Folder): number {
  const orderA = SYSTEM_FOLDER_ORDER[a.gmailLabelId]
    ?? (a.specialUse ? SPECIAL_USE_ORDER[a.specialUse] : undefined)
    ?? Number.MAX_SAFE_INTEGER;
  const orderB = SYSTEM_FOLDER_ORDER[b.gmailLabelId]
    ?? (b.specialUse ? SPECIAL_USE_ORDER[b.specialUse] : undefined)
    ?? Number.MAX_SAFE_INTEGER;

  if (orderA !== orderB) {
    return orderA - orderB;
  }

  return a.name.localeCompare(b.name);
}

function normalizeFolderId(folderId: string): string {
  const normalized = folderId.trim();
  if (normalized.toLowerCase() === 'inbox') {
    return 'INBOX';
  }
  return normalized;
}

function resolveActiveFolderId(
  searchActive: boolean,
  currentActiveFolderId: string | null,
  folders: Folder[],
): string | null {
  if (searchActive) {
    return null;
  }

  const normalizedCurrentActive = currentActiveFolderId ? normalizeFolderId(currentActiveFolderId) : null;
  const currentFolderStillExists = normalizedCurrentActive !== null
    && folders.some((folder) => folder.gmailLabelId === normalizedCurrentActive);

  if (currentFolderStillExists) {
    return normalizedCurrentActive;
  }

  return 'INBOX';
}

export const FoldersStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),

  withComputed((store) => ({
    activeFolder: computed(() => {
      const id = store.activeFolderId();
      return store.folders().find(f => f.gmailLabelId === id) ?? null;
    }),
    systemFolders: computed(() =>
      [...store.folders().filter(f => f.type === 'system')].sort(compareSystemFolders)
    ),
    userLabels: computed(() =>
      store.folders().filter(f => f.type === 'user')
    ),
    inboxUnread: computed(() => {
      const inbox = store.folders().find(f => f.gmailLabelId === 'INBOX');
      return inbox?.unreadCount ?? 0;
    }),
    /**
     * The gmailLabelId of the account's trash folder (locale-aware).
     * Primary: finds a folder with specialUse === '\\Trash'.
     * Legacy fallback: finds '[Gmail]/Bin' by gmailLabelId (UK locale, before first sync populates specialUse).
     * Final fallback: '[Gmail]/Trash'.
     */
    trashFolderId: computed(() => {
      const folders = store.folders();
      const bySpecialUse = folders.find(f => f.specialUse === '\\Trash');
      if (bySpecialUse) {
        return bySpecialUse.gmailLabelId;
      }
      const byBin = folders.find(f => f.gmailLabelId === '[Gmail]/Bin');
      if (byBin) {
        return byBin.gmailLabelId;
      }
      return '[Gmail]/Trash';
    }),
    /**
     * The gmailLabelId of the account's spam/junk folder (locale-aware).
     * Primary: finds a folder with specialUse === '\\Junk'.
     * Final fallback: '[Gmail]/Spam'.
     */
    spamFolderId: computed(() => {
      const folders = store.folders();
      const bySpecialUse = folders.find(f => f.specialUse === '\\Junk');
      if (bySpecialUse) {
        return bySpecialUse.gmailLabelId;
      }
      return '[Gmail]/Spam';
    }),
  })),

  withMethods((store) => {
    const electronService = inject(ElectronService);

    return {
      async loadFolders(accountId: number): Promise<void> {
        patchState(store, { loading: true, error: null });
        try {
          const response = await electronService.getFolders(String(accountId));
          if (response.success && response.data) {
            const rawFolders = response.data as Array<Record<string, unknown>>;
            const folders: Folder[] = rawFolders.map((rawFolder) => {
              const gmailLabelId = rawFolder['gmailLabelId'] as string;
              const specialUse = (rawFolder['specialUse'] as string | null | undefined) ?? null;
              const isSystemFolder = isRecognizedSystemFolder({ gmailLabelId, specialUse });
              const icon = (rawFolder['icon'] as string | undefined)
                || FOLDER_ICON_MAP[gmailLabelId]
                || (specialUse ? SPECIAL_USE_ICON_MAP[specialUse] : undefined);

              return {
                id: rawFolder['id'] as number,
                accountId: rawFolder['accountId'] as number,
                gmailLabelId,
                name: rawFolder['name'] as string,
                type: isSystemFolder ? 'system' : 'user',
                color: rawFolder['color'] as string | undefined,
                unreadCount: rawFolder['unreadCount'] as number,
                totalCount: rawFolder['totalCount'] as number,
                icon,
                specialUse,
              };
            });

            // Preserve the virtual search view during background refreshes.
            // Search mode intentionally has no real active folder, so reloading the
            // folder list must not silently fall back to INBOX and replace the
            // current search results with folder contents.
            const activeId = resolveActiveFolderId(store.searchActive(), store.activeFolderId(), folders);

            // Only update activeFolderId if it actually changed to avoid triggering change detection errors
            if (store.activeFolderId() !== activeId) {
              patchState(store, { folders, activeFolderId: activeId, loading: false });
            } else {
              patchState(store, { folders, loading: false });
            }
          } else {
            patchState(store, {
              loading: false,
              error: response.error?.message || 'Failed to load folders',
            });
          }
        } catch (err: unknown) {
          patchState(store, {
            loading: false,
            error: err instanceof Error ? err.message : 'Failed to load folders',
          });
        }
      },

      normalizeFolderId(folderId: string): string {
        return normalizeFolderId(folderId);
      },

      setActiveFolder(folderId: string): void {
        patchState(store, { activeFolderId: this.normalizeFolderId(folderId) });
      },

      clearFolders(): void {
        patchState(store, { folders: [], activeFolderId: null });
      },

      /** Activate search mode — shows virtual Search Results folder */
      activateSearch(displayQuery: string, effectiveQuery?: string): void {
        const previousFolderId = store.searchActive()
          ? store.previousFolderId()
          : store.activeFolderId();
        patchState(store, {
          searchActive: true,
          searchQuery: effectiveQuery || displayQuery,
          searchDisplayQuery: displayQuery,
          searchResultCount: 0,
          searchingImap: false,
          searchImapError: null,
          previousFolderId,
          activeFolderId: null, // No real folder is active during search
        });
      },

      /** Deactivate search mode — restores previous folder */
      deactivateSearch(): void {
        const prevFolder = store.previousFolderId();
        patchState(store, {
          searchActive: false,
          searchQuery: null,
          searchDisplayQuery: null,
          searchResultCount: 0,
          searchingImap: false,
          searchImapError: null,
          previousFolderId: null,
          activeFolderId: prevFolder || 'INBOX',
        });
      },

      /** Update the search result count (called as results arrive) */
      updateSearchResultCount(count: number): void {
        patchState(store, { searchResultCount: count });
      },

      /** Create a new user label on IMAP and in the local DB, then reload folders. */
      async createLabel(accountId: number, name: string, color: string | null): Promise<void> {
        const response = await electronService.createLabel(String(accountId), name, color);
        if (!response.success) {
          throw new Error(response.error?.message || 'Failed to create label');
        }
        await this.loadFolders(accountId);
      },

      /** Delete a user label from IMAP and local DB, then reload folders. */
      async deleteLabel(accountId: number, gmailLabelId: string): Promise<void> {
        const response = await electronService.deleteLabel(String(accountId), gmailLabelId);
        if (!response.success) {
          throw new Error(response.error?.message || 'Failed to delete label');
        }
        await this.loadFolders(accountId);
      },

      /**
       * Update the color for a label.
       * Optimistically patches the in-memory folders array without a full reload.
       */
      async updateLabelColor(accountId: number, gmailLabelId: string, color: string | null): Promise<void> {
        const response = await electronService.updateLabelColor(String(accountId), gmailLabelId, color);
        if (!response.success) {
          throw new Error(response.error?.message || 'Failed to update label color');
        }
        // Optimistic patch: update the color in the current folders signal
        const updatedFolders = store.folders().map((folder) => {
          if (folder.gmailLabelId === gmailLabelId) {
            return { ...folder, color: color ?? undefined };
          }
          return folder;
        });
        patchState(store, { folders: updatedFolders });
      },
    };
  })
);
