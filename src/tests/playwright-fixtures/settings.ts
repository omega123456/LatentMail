import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightSettings: IpcCommandMap['read_settings']['result'] = {
  theme: 'system',
  layout: 'three-column',
  density: 'comfortable',
  sidebarCollapsed: false,
  sidebarWidth: 260,
  listWidth: 350,
  readerHeight: 40,
  syncOnStartup: true,
  showUnreadCounts: true,
  syncIntervalMinutes: 5,
};
