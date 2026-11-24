import { openNewMessage } from '@/lib/compose/entry';
import { invoke } from '@/lib/ipc/commands';
import type { OsIntent } from '@/lib/types/ipc';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { useSettingsUiStore } from '@/stores/settings-ui';

async function activeAccount() {
  const accountId = useSelectionStore.getState().activeAccountId;
  if (!accountId) return null;
  return (await invoke('list_accounts', {})).find((account) => account.id === accountId) ?? null;
}

type OsIntentHandlers = {
  [Kind in OsIntent['kind']]: (intent: Extract<OsIntent, { kind: Kind }>) => Promise<void> | void;
};

const OS_INTENT_HANDLERS: OsIntentHandlers = {
  openAccounts: () => {
    useSettingsUiStore.getState().setActiveSection('accounts');
    useLayoutStore.getState().setRoute('settings');
  },
  compose: async () => {
    const account = await activeAccount();
    if (!account) return;
    useLayoutStore.getState().setRoute('mail');
    openNewMessage(account.id, account.email);
  },
  mailto: async (intent) => {
    const account = await activeAccount();
    if (!account) return;
    useLayoutStore.getState().setRoute('mail');
    openNewMessage(account.id, account.email, intent.mailto);
  },
  openFolder: (intent) => {
    useLayoutStore.getState().setRoute('mail');
    useSelectionStore.getState().setActiveAccountId(intent.accountId);
    useSelectionStore.getState().setActiveMailboxId('INBOX');
  },
  openThread: async (intent) => {
    useLayoutStore.getState().setRoute('mail');
    const selection = useSelectionStore.getState();
    selection.setActiveAccountId(intent.accountId);
    selection.setActiveMailboxId('INBOX');
    selection.setActiveThreadId(intent.threadId);
    selection.setFlashThreadId(intent.threadId);
    await invoke('mark_thread_read', { accountId: intent.accountId, threadId: intent.threadId });
  },
  syncNow: async () => {
    const account = await activeAccount();
    if (!account) return;
    await invoke('trigger_sync', { accountId: account.id });
  },
};

export async function handleOsIntent(intent: OsIntent): Promise<void> {
  const handler = OS_INTENT_HANDLERS[intent.kind] as (payload: OsIntent) => Promise<void> | void;
  await handler(intent);
}
