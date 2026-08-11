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
    sidebarWidth = Math.min(400, Math.max(180, sidebarWidth));
    set({ sidebarWidth });
    persist('sidebarWidth', sidebarWidth);
  },
  setListWidth: (listWidth) => {
    listWidth = Math.min(600, Math.max(240, listWidth));
    set({ listWidth });
    persist('listWidth', listWidth);
  },
  setReaderHeight: (readerHeight) => {
    readerHeight = Math.min(80, Math.max(20, readerHeight));
    set({ readerHeight });
    persist('readerHeight', readerHeight);
  },
}));
