import { computed, inject } from '@angular/core';
import { signalStore, withState, withMethods, withComputed, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { Folder } from '../core/models/account.model';

interface FoldersState {
  folders: Folder[];
  activeFolderId: string | null;
  loading: boolean;
  error: string | null;
}

const initialState: FoldersState = {
  folders: [],
  activeFolderId: null,
  loading: false,
  error: null,
};

/** Map Gmail special-use paths to icons */
const FOLDER_ICON_MAP: Record<string, string> = {
  'INBOX': 'inbox',
  '[Gmail]/Sent Mail': 'send',
  '[Gmail]/Drafts': 'edit_note',
  '[Gmail]/Trash': 'delete',
  '[Gmail]/Spam': 'report',
  '[Gmail]/All Mail': 'all_inbox',
  '[Gmail]/Starred': 'star',
  '[Gmail]/Important': 'label_important',
};

export const FoldersStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),

  withComputed((store) => ({
    activeFolder: computed(() => {
      const id = store.activeFolderId();
      return store.folders().find(f => f.gmailLabelId === id) ?? null;
    }),
    systemFolders: computed(() =>
      store.folders().filter(f => f.type === 'system')
    ),
    userLabels: computed(() =>
      store.folders().filter(f => f.type === 'user')
    ),
    inboxUnread: computed(() => {
      const inbox = store.folders().find(f => f.gmailLabelId === 'INBOX');
      return inbox?.unreadCount ?? 0;
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
            const folders: Folder[] = rawFolders.map(f => ({
              id: f['id'] as number,
              accountId: f['accountId'] as number,
              gmailLabelId: f['gmailLabelId'] as string,
              name: f['name'] as string,
              type: f['type'] as 'system' | 'user',
              color: f['color'] as string | undefined,
              unreadCount: f['unreadCount'] as number,
              totalCount: f['totalCount'] as number,
              icon: FOLDER_ICON_MAP[f['gmailLabelId'] as string],
            }));

            // Default to INBOX if no active folder
            const currentActive = store.activeFolderId();
            const activeId = currentActive && folders.find(f => f.gmailLabelId === currentActive)
              ? currentActive
              : 'INBOX';

            patchState(store, { folders, activeFolderId: activeId, loading: false });
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

      setActiveFolder(folderId: string): void {
        patchState(store, { activeFolderId: folderId });
      },

      clearFolders(): void {
        patchState(store, { folders: [], activeFolderId: null });
      },
    };
  })
);
