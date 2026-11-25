import { create } from 'zustand';
import { dispatchSetZoom } from '@/lib/ipc/dispatch';
import { invoke } from '@/lib/ipc/commands';
import { hydrateSettings } from '@/lib/settings/hydrate';
import type { Density, LayoutMode, LogLevel, Settings, UpdateCheckInterval } from '@/lib/types/ipc';
import { percentToFraction, WHOLE_PERCENT } from '@/lib/format/percent';
import {
  addTrustedImageSender,
  ASSISTANT_WIDTH_RANGE,
  clampSize,
  DEFAULT_PERSISTED_SETTINGS,
  LIST_WIDTH_RANGE,
  nextDensityMode,
  nextLayoutMode,
  pickPersistedSettings,
  READER_HEIGHT_PERCENT_RANGE,
  removeTrustedImageSender,
  SIDEBAR_WIDTH_RANGE,
  type PersistedLayoutSettings,
} from './layout/transitions';

export type Route = 'auth' | 'mail' | 'settings';

export const ASSISTANT_DOCK_MIN_SHELL_WIDTH = 1200;

type LayoutState = PersistedLayoutSettings & {
  route: Route;
  hydrated: boolean;
  assistantOpen: boolean;
  setAssistantOpen: (assistantOpen: boolean) => void;
  setAssistantWidth: (assistantWidth: number) => void;
  hydrate: () => Promise<void>;
  setRoute: (route: Route) => void;
  setLayout: (layout: LayoutMode) => void;
  cycleLayout: () => void;
  setDensity: (density: Density) => void;
  cycleDensity: () => void;
  setSidebarCollapsed: (sidebarCollapsed: boolean) => void;
  setSidebarWidth: (sidebarWidth: number) => void;
  setListWidth: (listWidth: number) => void;
  setReaderHeight: (readerHeight: number) => void;
  setShowUnreadCounts: (showUnreadCounts: boolean) => void;
  setShowSenderAvatars: (showSenderAvatars: boolean) => void;
  setZoomPercent: (zoomPercent: number) => void;
  setSyncOnStartup: (syncOnStartup: boolean) => void;
  setSyncIntervalSeconds: (syncIntervalSeconds: number) => void;
  setAlwaysLoadRemoteImages: (alwaysLoadRemoteImages: boolean) => void;
  setLogLevel: (logLevel: LogLevel) => void;
  setPrefetchImageAttachments: (prefetchImageAttachments: boolean) => void;
  setStartAtLogin: (startAtLogin: boolean) => void;
  setCloseToTray: (closeToTray: boolean) => void;
  setStartMinimized: (startMinimized: boolean) => void;
  setDesktopNotifications: (desktopNotifications: boolean) => void;
  setUpdateCheckInterval: (updateCheckInterval: UpdateCheckInterval) => void;
  setInstallUpdateOnQuit: (installUpdateOnQuit: boolean) => void;
  trustImageSender: (address: string) => void;
  untrustImageSender: (address: string) => void;
};

export function applyZoom(zoomPercent: number) {
  void dispatchSetZoom(percentToFraction(zoomPercent)).catch(() => undefined);
}

function persist<Key extends keyof Settings>(key: Key, value: Settings[Key]) {
  void invoke('write_setting', { key: key, value: value }).catch(() => undefined);
}

export const useLayoutStore = create<LayoutState>((set, get) => {
  const persistedSetter =
    <Key extends keyof PersistedLayoutSettings>(
      key: Key,
      transform?: (value: Settings[Key]) => Settings[Key],
    ) =>
    (incoming: Settings[Key]) => {
      const next = transform ? transform(incoming) : incoming;
      set({ [key]: next } as Partial<LayoutState>);
      persist(key, next);
    };

  const setLayout = persistedSetter('layout');
  const setDensity = persistedSetter('density');
  const setAllowedImageSenders = persistedSetter('allowedImageSenders');

  return {
    ...DEFAULT_PERSISTED_SETTINGS,
    assistantOpen: false,
    route: 'mail',
    hydrated: false,
    hydrate: () =>
      hydrateSettings().then((settings) => {
        applyZoom(settings.zoomPercent);
        set({ ...pickPersistedSettings(settings), hydrated: true });
      }),
    setRoute: (route) => set({ route }),
    setLayout: setLayout,
    cycleLayout: () => setLayout(nextLayoutMode(get().layout)),
    setDensity: setDensity,
    cycleDensity: () => setDensity(nextDensityMode(get().density)),
    setSidebarCollapsed: persistedSetter('sidebarCollapsed'),
    setSidebarWidth: persistedSetter('sidebarWidth', (size) =>
      clampSize(size, SIDEBAR_WIDTH_RANGE),
    ),
    setListWidth: persistedSetter('listWidth', (size) => clampSize(size, LIST_WIDTH_RANGE)),
    setReaderHeight: persistedSetter('readerHeight', (size) =>
      clampSize(size, READER_HEIGHT_PERCENT_RANGE),
    ),
    setAssistantOpen: (assistantOpen) => set({ assistantOpen }),
    setAssistantWidth: persistedSetter('assistantWidth', (size) =>
      clampSize(size, ASSISTANT_WIDTH_RANGE),
    ),
    setShowUnreadCounts: persistedSetter('showUnreadCounts'),
    setShowSenderAvatars: persistedSetter('showSenderAvatars'),
    setZoomPercent: (zoomPercent) => {
      applyZoom(zoomPercent);
      set({ zoomPercent });
      persist('zoomPercent', zoomPercent);
    },
    setSyncOnStartup: persistedSetter('syncOnStartup'),
    setSyncIntervalSeconds: persistedSetter('syncIntervalSeconds'),
    setAlwaysLoadRemoteImages: persistedSetter('alwaysLoadRemoteImages'),
    setLogLevel: persistedSetter('logLevel'),
    setPrefetchImageAttachments: persistedSetter('prefetchImageAttachments'),
    setStartAtLogin: persistedSetter('startAtLogin'),
    setCloseToTray: persistedSetter('closeToTray'),
    setStartMinimized: persistedSetter('startMinimized'),
    setDesktopNotifications: persistedSetter('desktopNotifications'),
    setUpdateCheckInterval: persistedSetter('updateCheckInterval'),
    setInstallUpdateOnQuit: persistedSetter('installUpdateOnQuit'),
    trustImageSender: (address) => {
      const next = addTrustedImageSender(get().allowedImageSenders, address);
      if (next) setAllowedImageSenders(next);
    },
    untrustImageSender: (address) =>
      setAllowedImageSenders(removeTrustedImageSender(get().allowedImageSenders, address)),
  };
});

applyZoom(WHOLE_PERCENT);
