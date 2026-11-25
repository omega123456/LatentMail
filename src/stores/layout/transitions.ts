import type { Density, LayoutMode, Settings } from '@/lib/types/ipc';
import { clamp, wrapIndex } from '@/lib/collections';

export type PersistedLayoutSettings = Pick<
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

export type SizeRange = { min: number; max: number };

export const SIDEBAR_WIDTH_RANGE: SizeRange = { min: 180, max: 400 };
export const LIST_WIDTH_RANGE: SizeRange = { min: 240, max: 600 };
export const READER_HEIGHT_PERCENT_RANGE: SizeRange = { min: 20, max: 80 };
export const ASSISTANT_WIDTH_RANGE: SizeRange = { min: 280, max: 700 };

const LAYOUT_MODES: LayoutMode[] = ['three-column', 'bottom-preview', 'list-only'];
const DENSITY_MODES: Density[] = ['compact', 'comfortable', 'spacious'];

export const DEFAULT_PERSISTED_SETTINGS: PersistedLayoutSettings = {
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

export function clampSize(size: number, range: SizeRange): number {
  return Math.round(clamp(size, range.min, range.max));
}

export function pickPersistedSettings(settings: Settings): PersistedLayoutSettings {
  const result = { ...DEFAULT_PERSISTED_SETTINGS };
  for (const key of PERSISTED_KEYS) {
    Object.assign(result, { [key]: settings[key] });
  }
  result.assistantWidth = clampSize(settings.assistantWidth, ASSISTANT_WIDTH_RANGE);
  return result;
}

export function nextLayoutMode(current: LayoutMode): LayoutMode {
  return LAYOUT_MODES[wrapIndex(LAYOUT_MODES.indexOf(current), 1, LAYOUT_MODES.length)];
}

export function nextDensityMode(current: Density): Density {
  return DENSITY_MODES[wrapIndex(DENSITY_MODES.indexOf(current), 1, DENSITY_MODES.length)];
}

export function addTrustedImageSender(current: string[], address: string): string[] | null {
  const normalized = address.trim().toLowerCase();
  if (!normalized || current.includes(normalized)) return null;
  return [...current, normalized];
}

export function removeTrustedImageSender(current: string[], address: string): string[] {
  const normalized = address.trim().toLowerCase();
  return current.filter((entry) => entry !== normalized);
}
