import { inject } from '@angular/core';
import { signalStore, withState, withMethods, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { ThemeMode } from '../core/services/theme.service';
import { LayoutMode, DensityMode } from '../core/services/layout.service';

export interface SettingsState {
  theme: ThemeMode;
  layout: LayoutMode;
  density: DensityMode;
  syncInterval: number; // minutes (UI-facing)
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
          const rawSyncInterval = data['syncInterval'] ? Number(data['syncInterval']) : null;
          const syncIntervalMinutes = rawSyncInterval === null
            ? store.syncInterval()
            : rawSyncInterval >= 1000
              ? Math.max(1, Math.round(rawSyncInterval / 60000))
              : Math.max(1, rawSyncInterval);
          patchState(store, {
            theme: (data['theme'] as ThemeMode) || store.theme(),
            layout: (data['layout'] as LayoutMode) || store.layout(),
            density: (data['density'] as DensityMode) || store.density(),
            syncInterval: syncIntervalMinutes,
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
        const parsedValue = key === 'syncInterval'
          ? Number(value) >= 1000
            ? Math.max(1, Math.round(Number(value) / 60000))
            : Math.max(1, Number(value))
          : ['true', 'false'].includes(value)
            ? value === 'true'
            : value;
        patchState(store, { [key]: parsedValue } as Partial<SettingsState>);
        const persistedValue = key === 'syncInterval'
          ? String(Number(value) >= 1000 ? Number(value) : Math.max(1, Number(value)) * 60000)
          : value;
        await electronService.setSettings({ [key]: persistedValue });
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
        const safeMinutes = Math.max(1, minutes);
        patchState(store, { syncInterval: safeMinutes });
        await electronService.setSettings({ syncInterval: String(safeMinutes * 60000) });
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
