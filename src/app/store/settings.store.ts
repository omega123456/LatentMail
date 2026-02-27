import { inject } from '@angular/core';
import { signalStore, withState, withMethods, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { ThemeMode } from '../core/services/theme.service';
import { LayoutMode, DensityMode } from '../core/services/layout.service';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const VALID_LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'];

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
  /** When true, closing the main window on Windows hides it to the system tray instead of quitting. */
  closeToTray: boolean;
  logLevel: LogLevel;
  /** Custom keybinding overrides: command ID → normalized key combo string. */
  customKeyBindings: Record<string, string>;
  /**
   * Email addresses whose remote images are always loaded, even when
   * `blockRemoteImages` is true.  Comparison is case-insensitive.
   */
  allowedImageSenders: string[];
  /** UI zoom level as a percentage (e.g. 100 = 100%). Persisted as a string in the DB. */
  zoomLevel: number;
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
  closeToTray: true,
  logLevel: 'error',
  zoomLevel: 100,
  customKeyBindings: {},
  allowedImageSenders: [],
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
          const storedLogLevel = data['logLevel'];
          const logLevel: LogLevel = (VALID_LOG_LEVELS as readonly string[]).includes(storedLogLevel)
            ? (storedLogLevel as LogLevel)
            : 'error';
          let customKeyBindings: Record<string, string> = {};
          const rawKeyBindings = data['customKeyBindings'];
          if (rawKeyBindings) {
            try {
              customKeyBindings = JSON.parse(rawKeyBindings) as Record<string, string>;
            } catch {
              customKeyBindings = {};
            }
          }
          let allowedImageSenders: string[] = [];
          const rawAllowedSenders = data['allowedImageSenders'];
          if (rawAllowedSenders) {
            try {
              const parsed = JSON.parse(rawAllowedSenders);
              if (Array.isArray(parsed)) {
                allowedImageSenders = parsed.filter(
                  (entry): entry is string => typeof entry === 'string',
                );
              }
            } catch {
              allowedImageSenders = [];
            }
          }
          const rawZoomLevel = data['zoomLevel'] ? Number(data['zoomLevel']) : NaN;
          const zoomLevel = isNaN(rawZoomLevel) ? 100 : Math.min(150, Math.max(75, rawZoomLevel));
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
            closeToTray: data['closeToTray'] !== undefined ? data['closeToTray'] === 'true' : store.closeToTray(),
            logLevel,
            customKeyBindings,
            allowedImageSenders,
            zoomLevel,
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

      /**
       * Update the log level in local state and notify the main process via the
       * dedicated `db:set-log-level` IPC channel.  The main process applies the
       * change immediately and persists it — the renderer does NOT call db:set-settings
       * for this key.
       *
       * State is patched only after a successful IPC response to avoid a stale
       * optimistic update that would revert on the next app restart.
       */
      async setLogLevel(level: LogLevel): Promise<void> {
        const response = await electronService.setLogLevel(level);
        if (response.success) {
          patchState(store, { logLevel: level });
        }
      },

      /**
       * Override the keybinding for a command.
       * Persists the full customKeyBindings map as JSON in the settings DB.
       */
      async setKeyBinding(commandId: string, keys: string): Promise<void> {
        const updated = { ...store.customKeyBindings(), [commandId]: keys };
        patchState(store, { customKeyBindings: updated });
        await electronService.setSettings({ customKeyBindings: JSON.stringify(updated) });
      },

      /**
       * Remove a custom keybinding override, restoring the command's default.
       */
      async resetKeyBinding(commandId: string): Promise<void> {
        const updated = { ...store.customKeyBindings() };
        delete updated[commandId];
        patchState(store, { customKeyBindings: updated });
        await electronService.setSettings({ customKeyBindings: JSON.stringify(updated) });
      },

      /**
       * Clear ALL custom keybinding overrides in one operation,
       * restoring every command to its default binding.
       */
      async resetAllKeyBindings(): Promise<void> {
        patchState(store, { customKeyBindings: {} });
        await electronService.setSettings({ customKeyBindings: '{}' });
      },

      /**
       * Add an email address to the remote-image allowlist.
       * Images from this sender will always load even when `blockRemoteImages` is true.
       */
      async setZoomLevel(level: number): Promise<void> {
        const clampedLevel = isNaN(level) ? 100 : Math.min(150, Math.max(75, level));
        patchState(store, { zoomLevel: clampedLevel });
        await electronService.setSettings({ zoomLevel: String(clampedLevel) });
      },

      async addAllowedImageSender(email: string): Promise<void> {
        const normalized = email.trim().toLowerCase();
        if (!normalized) {
          return;
        }
        const current = store.allowedImageSenders();
        if (current.some((s) => s.toLowerCase() === normalized)) {
          return; // already in the list
        }
        const updated = [...current, normalized];
        patchState(store, { allowedImageSenders: updated });
        await electronService.setSettings({ allowedImageSenders: JSON.stringify(updated) });
      },

      /**
       * Remove an email address from the remote-image allowlist.
       */
      async removeAllowedImageSender(email: string): Promise<void> {
        const normalized = email.trim().toLowerCase();
        const updated = store.allowedImageSenders().filter(
          (s) => s.toLowerCase() !== normalized,
        );
        patchState(store, { allowedImageSenders: updated });
        await electronService.setSettings({ allowedImageSenders: JSON.stringify(updated) });
      },
    };
  })
);
