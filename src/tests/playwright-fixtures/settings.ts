import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightSettings: IpcCommandMap['read_settings']['result'] = {
  theme: 'system',
  layout: 'three-column',
  density: 'comfortable',
  sidebarCollapsed: false,
  sidebarWidth: 260,
  listWidth: 350,
  readerHeight: 40,
  assistantWidth: 360,
  syncOnStartup: true,
  showUnreadCounts: true,
  syncIntervalSeconds: 300,
  showSenderAvatars: true,
  zoomPercent: 100,
  alwaysLoadRemoteImages: false,
  allowedImageSenders: [],
  commandOverrides: {
    replyAllToMessage: ['Shift+A'],
  },
  logLevel: 'info',
  prefetchImageAttachments: false,
  startAtLogin: false,
  closeToTray: true,
  startMinimized: false,
  desktopNotifications: true,
  updateCheckInterval: '1d',
  installUpdateOnQuit: true,
};

export const playwrightTrustedSenderSettings: IpcCommandMap['read_settings']['result'] = {
  ...playwrightSettings,
  allowedImageSenders: [
    'alerts@monzo.com',
    'billing@acme-cloud.com',
    'connect@figma.com',
    'digest@substack.com',
    'hello@readwise.io',
    'invoices@hetzner.com',
    'mail@notion.so',
    'news@economist.com',
    'no-reply@github.com',
    'orders@bandcamp.com',
    'receipts@stripe.com',
    'team@linear.app',
  ],
};
