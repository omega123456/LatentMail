import { create } from 'zustand';
import { invoke } from '@/lib/ipc/commands';
import type { Density, LayoutMode, LogLevel, Settings, UpdateCheckInterval } from '@/lib/types/ipc';

export type Route = 'auth' | 'mail' | 'settings';

type LayoutState = Pick<
  Settings,
  | 'layout'
  | 'density'
  | 'sidebarCollapsed'
  | 'sidebarWidth'
  | 'listWidth'
  | 'readerHeight'
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
> & {
  route: Route;
  hydrated: boolean;
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

let hydration: Promise<void> | undefined;

function clampSize(value: number, min: number, max: number) {
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function applyZoom(zoomPercent: number) {
  const scale = zoomPercent / 100;
  document.body.style.zoom = String(scale);
  document.body.style.width = `${window.innerWidth / scale}px`;
  document.body.style.height = `${window.innerHeight / scale}px`;
}

function persist<K extends keyof Settings>(key: K, value: Settings[K]) {
  void invoke('write_setting', { key, value }).catch(() => undefined);
}

export const useLayoutStore = create<LayoutState>((set) => ({
  layout: 'three-column',
  density: 'comfortable',
  sidebarCollapsed: false,
  sidebarWidth: 260,
  listWidth: 350,
  readerHeight: 40,
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
  route: 'mail',
  hydrated: false,
  hydrate: () => {
    hydration ??= invoke('read_settings', {}).then((settings) => {
      applyZoom(settings.zoomPercent);
      set({
        layout: settings.layout,
        density: settings.density,
        sidebarCollapsed: settings.sidebarCollapsed,
        sidebarWidth: settings.sidebarWidth,
        listWidth: settings.listWidth,
        readerHeight: settings.readerHeight,
        showUnreadCounts: settings.showUnreadCounts,
        showSenderAvatars: settings.showSenderAvatars,
        zoomPercent: settings.zoomPercent,
        syncOnStartup: settings.syncOnStartup,
        syncIntervalSeconds: settings.syncIntervalSeconds,
        alwaysLoadRemoteImages: settings.alwaysLoadRemoteImages,
        allowedImageSenders: settings.allowedImageSenders,
        logLevel: settings.logLevel,
        prefetchImageAttachments: settings.prefetchImageAttachments,
        startAtLogin: settings.startAtLogin,
        closeToTray: settings.closeToTray,
        startMinimized: settings.startMinimized,
        desktopNotifications: settings.desktopNotifications,
        updateCheckInterval: settings.updateCheckInterval,
        installUpdateOnQuit: settings.installUpdateOnQuit,
        hydrated: true,
      });
    });
    return hydration;
  },
  setRoute: (route) => set({ route }),
  setLayout: (layout) => {
    set({ layout });
    persist('layout', layout);
  },
  cycleLayout: () => {
    const layouts: LayoutMode[] = ['three-column', 'bottom-preview', 'list-only'];
    const layout =
      layouts[(layouts.indexOf(useLayoutStore.getState().layout) + 1) % layouts.length];
    useLayoutStore.getState().setLayout(layout);
  },
  setDensity: (density) => {
    set({ density });
    persist('density', density);
  },
  cycleDensity: () => {
    const densities: Density[] = ['compact', 'comfortable', 'spacious'];
    const density =
      densities[(densities.indexOf(useLayoutStore.getState().density) + 1) % densities.length];
    useLayoutStore.getState().setDensity(density);
  },
  setSidebarCollapsed: (sidebarCollapsed) => {
    set({ sidebarCollapsed });
    persist('sidebarCollapsed', sidebarCollapsed);
  },
  setSidebarWidth: (sidebarWidth) => {
    sidebarWidth = clampSize(sidebarWidth, 180, 400);
    set({ sidebarWidth });
    persist('sidebarWidth', sidebarWidth);
  },
  setListWidth: (listWidth) => {
    listWidth = clampSize(listWidth, 240, 600);
    set({ listWidth });
    persist('listWidth', listWidth);
  },
  setReaderHeight: (readerHeight) => {
    readerHeight = clampSize(readerHeight, 20, 80);
    set({ readerHeight });
    persist('readerHeight', readerHeight);
  },
  setShowUnreadCounts: (showUnreadCounts) => {
    set({ showUnreadCounts });
    persist('showUnreadCounts', showUnreadCounts);
  },
  setShowSenderAvatars: (showSenderAvatars) => {
    set({ showSenderAvatars });
    persist('showSenderAvatars', showSenderAvatars);
  },
  setZoomPercent: (zoomPercent) => {
    applyZoom(zoomPercent);
    set({ zoomPercent });
    persist('zoomPercent', zoomPercent);
  },
  setSyncOnStartup: (syncOnStartup) => {
    set({ syncOnStartup });
    persist('syncOnStartup', syncOnStartup);
  },
  setSyncIntervalSeconds: (syncIntervalSeconds) => {
    set({ syncIntervalSeconds });
    persist('syncIntervalSeconds', syncIntervalSeconds);
  },
  setAlwaysLoadRemoteImages: (alwaysLoadRemoteImages) => {
    set({ alwaysLoadRemoteImages });
    persist('alwaysLoadRemoteImages', alwaysLoadRemoteImages);
  },
  setLogLevel: (logLevel) => {
    set({ logLevel });
    persist('logLevel', logLevel);
  },
  setPrefetchImageAttachments: (prefetchImageAttachments) => {
    set({ prefetchImageAttachments });
    persist('prefetchImageAttachments', prefetchImageAttachments);
  },
  setStartAtLogin: (startAtLogin) => {
    set({ startAtLogin });
    persist('startAtLogin', startAtLogin);
  },
  setCloseToTray: (closeToTray) => {
    set({ closeToTray });
    persist('closeToTray', closeToTray);
  },
  setStartMinimized: (startMinimized) => {
    set({ startMinimized });
    persist('startMinimized', startMinimized);
  },
  setDesktopNotifications: (desktopNotifications) => {
    set({ desktopNotifications });
    persist('desktopNotifications', desktopNotifications);
  },
  setUpdateCheckInterval: (updateCheckInterval) => {
    set({ updateCheckInterval });
    persist('updateCheckInterval', updateCheckInterval);
  },
  setInstallUpdateOnQuit: (installUpdateOnQuit) => {
    set({ installUpdateOnQuit });
    persist('installUpdateOnQuit', installUpdateOnQuit);
  },
  trustImageSender: (address) => {
    const normalized = address.trim().toLowerCase();
    const current = useLayoutStore.getState().allowedImageSenders;
    if (!normalized || current.includes(normalized)) return;
    const allowedImageSenders = [...current, normalized];
    set({ allowedImageSenders });
    persist('allowedImageSenders', allowedImageSenders);
  },
  untrustImageSender: (address) => {
    const normalized = address.trim().toLowerCase();
    const allowedImageSenders = useLayoutStore
      .getState()
      .allowedImageSenders.filter((entry) => entry !== normalized);
    set({ allowedImageSenders });
    persist('allowedImageSenders', allowedImageSenders);
  },
}));

window.addEventListener('resize', () => {
  applyZoom(useLayoutStore.getState().zoomPercent);
});

applyZoom(100);
