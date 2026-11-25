import { type OpenComposeArgs, useComposeStore } from '@/stores/compose';

export const openSession = (overrides: Partial<OpenComposeArgs> = {}) =>
  useComposeStore.getState().open({
    id: 'session',
    mode: 'new',
    accountId: 'account',
    from: 'me@example.com',
    recipients: { to: [], cc: [], bcc: [] },
    subject: '',
    html: '',
    ...overrides,
  });
