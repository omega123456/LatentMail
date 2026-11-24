import { create } from 'zustand';
import { dispatchSetZoom } from '@/lib/ipc/dispatch';
import { invoke } from '@/lib/ipc/commands';
import { hydrateSettings } from '@/lib/settings/hydrate';
import type { Density, LayoutMode, LogLevel, Settings, UpdateCheckInterval } from '@/lib/types/ipc';
import { percentToFraction, WHOLE_PERCENT } from '@/lib/format/percent';
import { clamp, wrapIndex } from '@/lib/collections';

export type Route = 'auth' | 'mail' | 'settings';

export const ASSISTANT_DOCK_MIN_SHELL_WIDTH = 1200;

type PersistedLayoutSettings = Pick<
  Settings,
  | 'layout'
  | 'density'
  | 'sidebarCollapsed'
  | 'sidebarWidth'
  | 'listWidth'
  | 'readerHeight'
  | 'assistantWidth'
  | 'showUnreadCounts'
  | 'showSenderAvatars'
  | 'zoomPercent'
  | 'syncOnStartup'
  | 'syncIntervalSeconds'
  | 'alwaysLoadRemoteImages'
  | 'allowedImageSenders'
  | 'logLevel'
  | 'prefetchImageAttachments'
  | 'startAtLogin'
  | 'closeToTray'
  | 'startMinimized'
  | 'desktopNotifications'
  | 'updateCheckInterval'
  | 'installUpdateOnQuit'
>;

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

type SizeRange = { min: number; max: number };

const SIDEBAR_WIDTH_RANGE: SizeRange = { min: 180, max: 400 };
const LIST_WIDTH_RANGE: SizeRange = { min: 240, max: 600 };
const READER_HEIGHT_PERCENT_RANGE: SizeRange = { min: 20, max: 80 };
const ASSISTANT_WIDTH_RANGE: SizeRange = { min: 280, max: 700 };

const LAYOUT_MODES: LayoutMode[] = ['three-column', 'bottom-preview', 'list-only'];
const DENSITY_MODES: Density[] = ['compact', 'comfortable', 'spacious'];

function clampSize(size: number, range: SizeRange) {
  return Math.round(clamp(size, range.min, range.max));
}

export function applyZoom(zoomPercent: number) {
  void dispatchSetZoom(percentToFraction(zoomPercent)).catch(() => undefined);
}

function persist<Key extends keyof Settings>(key: Key, value: Settings[Key]) {
  void invoke('write_setting', { key: key, value: value }).catch(() => undefined);
}

const DEFAULT_PERSISTED_SETTINGS: PersistedLayoutSettings = {
  layout: 'three-column',
  density: 'comfortable',
  sidebarCollapsed: false,
  sidebarWidth: 260,
  listWidth: 350,
  readerHeight: 40,
  assistantWidth: 360,
  showUnreadCounts: true,
  showSenderAvatars: true,
  zoomPercent: 100,
  syncOnStartup: true,
  syncIntervalSeconds: 300,
  alwaysLoadRemoteImages: false,
  allowedImageSenders: [],
  logLevel: 'info',
  prefetchImageAttachments: false,
  startAtLogin: false,
  closeToTray: true,
  startMinimized: false,
  desktopNotifications: true,
  updateCheckInterval: '1d',
  installUpdateOnQuit: true,
};

const PERSISTED_KEYS = Object.keys(DEFAULT_PERSISTED_SETTINGS) as Array<
  keyof PersistedLayoutSettings
>;

function pickPersistedSettings(settings: Settings): PersistedLayoutSettings {
  const result = { ...DEFAULT_PERSISTED_SETTINGS };
  for (const key of PERSISTED_KEYS) {
    Object.assign(result, { [key]: settings[key] });
  }
  result.assistantWidth = clampSize(settings.assistantWidth, ASSISTANT_WIDTH_RANGE);
  return result;
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
    cycleLayout: () => {
      const currentIndex = LAYOUT_MODES.indexOf(get().layout);
      setLayout(LAYOUT_MODES[wrapIndex(currentIndex, 1, LAYOUT_MODES.length)]);
    },
    setDensity: setDensity,
    cycleDensity: () => {
      const currentIndex = DENSITY_MODES.indexOf(get().density);
      setDensity(DENSITY_MODES[wrapIndex(currentIndex, 1, DENSITY_MODES.length)]);
    },
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
      const normalized = address.trim().toLowerCase();
      const current = get().allowedImageSenders;
      if (!normalized || current.includes(normalized)) return;
      setAllowedImageSenders([...current, normalized]);
    },
    untrustImageSender: (address) => {
      const normalized = address.trim().toLowerCase();
      setAllowedImageSenders(get().allowedImageSenders.filter((entry) => entry !== normalized));
    },
  };
});

applyZoom(WHOLE_PERCENT);
