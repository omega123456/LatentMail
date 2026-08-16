import { create } from 'zustand';
import { invoke } from '@/lib/ipc/commands';
import type { Density, LayoutMode, Settings } from '@/lib/types/ipc';

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
};

let hydration: Promise<void> | undefined;

// Drag offsets are fractional pixels/percentages; the Rust settings are `u32`
// and reject anything else, so every pane size is rounded before it is stored.
function clampSize(value: number, min: number, max: number) {
  return Math.round(Math.min(max, Math.max(min, value)));
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
  route: 'mail',
  hydrated: false,
  hydrate: () => {
    hydration ??= invoke('read_settings', {}).then((settings) => {
      set({
        layout: settings.layout,
        density: settings.density,
        sidebarCollapsed: settings.sidebarCollapsed,
        sidebarWidth: settings.sidebarWidth,
        listWidth: settings.listWidth,
        readerHeight: settings.readerHeight,
        showUnreadCounts: settings.showUnreadCounts,
        showSenderAvatars: settings.showSenderAvatars,
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
}));
