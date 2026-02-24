import { computed } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState } from '@ngrx/signals';
import { LayoutMode, DensityMode } from '../core/services/layout.service';

export interface UiState {
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  emailListWidth: number;
  readingPaneHeight: number; // percentage for bottom-preview
  commandPaletteOpen: boolean;
  /** IDs of the last 5 executed commands (most recent first). */
  recentCommandIds: string[];
  layout: LayoutMode;
  density: DensityMode;
}

const initialState: UiState = {
  sidebarCollapsed: false,
  sidebarWidth: 240,
  emailListWidth: 320,
  readingPaneHeight: 45,
  commandPaletteOpen: false,
  recentCommandIds: [],
  layout: 'three-column',
  density: 'comfortable',
};

function loadUiState(): Partial<UiState> {
  const partial: Partial<UiState> = {};
  const sidebar = localStorage.getItem('ui.sidebarCollapsed');
  if (sidebar === 'true') partial.sidebarCollapsed = true;
  const sidebarWidth = localStorage.getItem('ui.sidebarWidth');
  if (sidebarWidth) partial.sidebarWidth = Number(sidebarWidth);
  const emailListWidth = localStorage.getItem('ui.emailListWidth');
  if (emailListWidth) partial.emailListWidth = Number(emailListWidth);
  const readingPaneHeight = localStorage.getItem('ui.readingPaneHeight');
  if (readingPaneHeight) partial.readingPaneHeight = Number(readingPaneHeight);
  const layout = localStorage.getItem('layout') as LayoutMode | null;
  if (layout) partial.layout = layout;
  const density = localStorage.getItem('density') as DensityMode | null;
  if (density) partial.density = density;
  return partial;
}

export const UiStore = signalStore(
  { providedIn: 'root' },
  withState({ ...initialState, ...loadUiState() }),
  withComputed((store) => ({
    effectiveSidebarWidth: computed(() =>
      store.sidebarCollapsed() ? 56 : store.sidebarWidth()
    ),
    densityHeight: computed(() => {
      switch (store.density()) {
        case 'compact': return 44;
        case 'comfortable': return 56;
        case 'spacious': return 72;
      }
    }),
    isThreeColumn: computed(() => store.layout() === 'three-column'),
    isBottomPreview: computed(() => store.layout() === 'bottom-preview'),
    isListOnly: computed(() => store.layout() === 'list-only'),
  })),
  withMethods((store) => ({
    toggleSidebar(): void {
      const collapsed = !store.sidebarCollapsed();
      patchState(store, { sidebarCollapsed: collapsed });
      localStorage.setItem('ui.sidebarCollapsed', String(collapsed));
    },
    setSidebarWidth(width: number): void {
      patchState(store, { sidebarWidth: Math.max(180, Math.min(400, width)) });
      localStorage.setItem('ui.sidebarWidth', String(store.sidebarWidth()));
    },
    setEmailListWidth(width: number): void {
      patchState(store, { emailListWidth: Math.max(240, Math.min(600, width)) });
      localStorage.setItem('ui.emailListWidth', String(store.emailListWidth()));
    },
    setReadingPaneHeight(percent: number): void {
      patchState(store, { readingPaneHeight: Math.max(20, Math.min(80, percent)) });
      localStorage.setItem('ui.readingPaneHeight', String(store.readingPaneHeight()));
    },
    setLayout(mode: LayoutMode): void {
      patchState(store, { layout: mode });
      localStorage.setItem('layout', mode);
    },
    setDensity(mode: DensityMode): void {
      patchState(store, { density: mode });
      localStorage.setItem('density', mode);
    },
    toggleCommandPalette(): void {
      patchState(store, { commandPaletteOpen: !store.commandPaletteOpen() });
    },
    openCommandPalette(): void {
      patchState(store, { commandPaletteOpen: true });
    },
    closeCommandPalette(): void {
      patchState(store, { commandPaletteOpen: false });
    },
    /**
     * Record an executed command ID in the recent-commands list.
     * Keeps the list at most 5 items, with the most recent first.
     * Duplicate entries are moved to the front rather than appended.
     */
    trackCommandExecution(commandId: string): void {
      const filtered = store.recentCommandIds().filter(id => id !== commandId);
      const updated = [commandId, ...filtered].slice(0, 5);
      patchState(store, { recentCommandIds: updated });
    },
  }))
);
