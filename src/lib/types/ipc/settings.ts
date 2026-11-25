export type ThemePreference = 'light' | 'dark' | 'system';
export type LayoutMode = 'three-column' | 'bottom-preview' | 'list-only';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type UpdateCheckInterval = '1h' | '5h' | '1d' | '7d' | 'off';

export interface UpdateSummary {
  version: string;
  notes: string | null;
  dateMillis: number | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  available: UpdateSummary | null;
}

export interface Settings {
  theme: ThemePreference;
  layout: LayoutMode;
  density: Density;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  listWidth: number;
  readerHeight: number;
  assistantWidth: number;
  syncOnStartup: boolean;
  showUnreadCounts: boolean;
  syncIntervalSeconds: number;
  showSenderAvatars: boolean;
  zoomPercent: number;
  alwaysLoadRemoteImages: boolean;
  allowedImageSenders: string[];
  commandOverrides: Partial<Record<string, string[]>>;
  logLevel: LogLevel;
  prefetchImageAttachments: boolean;
  startAtLogin: boolean;
  closeToTray: boolean;
  startMinimized: boolean;
  desktopNotifications: boolean;
  updateCheckInterval: UpdateCheckInterval;
  installUpdateOnQuit: boolean;
}

export interface LogEntryDto {
  timestampMillis: number;
  level: string;
  message: string;
}

export type SettingKey = keyof Settings;
export type SettingValue = Settings[SettingKey];

export interface DialogOpenOptions {
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
}

export interface DialogSaveOptions {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export type DragDropEvent =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

export type OsIntent =
  | { kind: 'compose' }
  | { kind: 'syncNow' }
  | { kind: 'openAccounts' }
  | {
      kind: 'mailto';
      mailto: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };
    }
  | { kind: 'openThread'; accountId: string; threadId: string }
  | { kind: 'openFolder'; accountId: string };
