import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightReauthAccount = {
  id: 'reauth-account',
  email: 'needs-attention@example.com',
  displayName: 'Needs Attention',
  avatarUrl: null,
  needsReauthentication: true,
} satisfies IpcCommandMap['list_accounts']['result'][number];

export const playwrightSidebarAccounts = [
  {
    id: 'sidebar-account',
    email: 'alex@example.com',
    displayName: 'Alex Morgan',
    avatarUrl: null,
    needsReauthentication: false,
  },
  playwrightReauthAccount,
] satisfies IpcCommandMap['list_accounts']['result'];

export const playwrightMailAccount = {
  ...playwrightReauthAccount,
  id: 'mail-account',
  needsReauthentication: false,
} satisfies IpcCommandMap['list_accounts']['result'][number];
