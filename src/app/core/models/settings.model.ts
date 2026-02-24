import type { ThemeMode } from '../services/theme.service';
import type { LayoutMode, DensityMode } from '../services/layout.service';

export interface AppSettings {
  theme: ThemeMode;
  layout: LayoutMode;
  density: DensityMode;
  sidebarCollapsed: boolean;
  showUnreadCounts: boolean;
  syncInterval: number;
  syncOnStartup: boolean;
  desktopNotifications: boolean;
  blockRemoteImages: boolean;
  showAvatars: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  /** Map of command ID → custom key combo string (e.g. `{ 'compose-new': 'ctrl+m' }`). */
  customKeyBindings: Record<string, string>;
  /**
   * Email addresses whose remote images are always loaded, even when
   * `blockRemoteImages` is `true`.  Comparison is case-insensitive.
   */
  allowedImageSenders: string[];
}

export const DEFAULT_SETTINGS: AppSettings = {
  theme: 'system',
  layout: 'three-column',
  density: 'comfortable',
  sidebarCollapsed: false,
  showUnreadCounts: true,
  syncInterval: 300000,
  syncOnStartup: true,
  desktopNotifications: true,
  blockRemoteImages: true,
  showAvatars: true,
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: '',
  customKeyBindings: {},
  allowedImageSenders: [],
};
