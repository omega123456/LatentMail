import { inject } from '@angular/core';
import { signalStore, withState, withMethods, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { ThemeMode } from '../core/services/theme.service';
import { LayoutMode, DensityMode } from '../core/services/layout.service';

export interface SettingsState {
  theme: ThemeMode;
  layout: LayoutMode;
  density: DensityMode;
  syncInterval: number; // minutes
  syncOnStartup: boolean;
  desktopNotifications: boolean;
  showUnreadCounts: boolean;
  blockRemoteImages: boolean;
  showAvatars: boolean;
  loading: boolean;
  error: string | null;
}

const initialState: SettingsState = {
  theme: 'system',
  layout: 'three-column',
  density: 'comfortable',
  syncInterval: 5,
  syncOnStartup: true,
  desktopNotifications: true,
  showUnreadCounts: true,
  blockRemoteImages: true,
  showAvatars: true,
  loading: false,
  error: null,
};

export const SettingsStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withMethods((store) => {
    const electronService = inject(ElectronService);

    return {
      async loadSettings(): Promise<void> {
        patchState(store, { loading: true, error: null });
        const response = await electronService.getSettings();
        if (response.success && response.data) {
          const data = response.data as Record<string, string>;
          patchState(store, {
            theme: (data['theme'] as ThemeMode) || store.theme(),
            layout: (data['layout'] as LayoutMode) || store.layout(),
            density: (data['density'] as DensityMode) || store.density(),
            syncInterval: data['syncInterval'] ? Number(data['syncInterval']) : store.syncInterval(),
            syncOnStartup: data['syncOnStartup'] !== undefined ? data['syncOnStartup'] === 'true' : store.syncOnStartup(),
            desktopNotifications: data['desktopNotifications'] !== undefined ? data['desktopNotifications'] === 'true' : store.desktopNotifications(),
            showUnreadCounts: data['showUnreadCounts'] !== undefined ? data['showUnreadCounts'] === 'true' : store.showUnreadCounts(),
            blockRemoteImages: data['blockRemoteImages'] !== undefined ? data['blockRemoteImages'] === 'true' : store.blockRemoteImages(),
            showAvatars: data['showAvatars'] !== undefined ? data['showAvatars'] === 'true' : store.showAvatars(),
            loading: false,
          });
        } else {
          patchState(store, { loading: false });
        }
      },

      async updateSetting(key: string, value: string): Promise<void> {
        patchState(store, { [key]: key === 'syncInterval' ? Number(value) : ['true', 'false'].includes(value) ? value === 'true' : value } as Partial<SettingsState>);
        await electronService.setSettings({ [key]: value });
      },

      async setTheme(theme: ThemeMode): Promise<void> {
        patchState(store, { theme });
        await electronService.setSettings({ theme });
      },

      async setLayout(layout: LayoutMode): Promise<void> {
        patchState(store, { layout });
        await electronService.setSettings({ layout });
      },

      async setDensity(density: DensityMode): Promise<void> {
        patchState(store, { density });
        await electronService.setSettings({ density });
      },

      async setSyncInterval(minutes: number): Promise<void> {
        patchState(store, { syncInterval: minutes });
        await electronService.setSettings({ syncInterval: String(minutes) });
      },

      async toggleSetting(key: keyof SettingsState): Promise<void> {
        const current = store[key]() as boolean;
        const newVal = !current;
        patchState(store, { [key]: newVal } as Partial<SettingsState>);
        await electronService.setSettings({ [key]: String(newVal) });
      },
    };
  })
);
