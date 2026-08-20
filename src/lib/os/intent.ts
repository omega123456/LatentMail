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

export async function handleOsIntent(intent: OsIntent): Promise<void> {
  if (intent.kind === 'openAccounts') {
    useSettingsUiStore.getState().setActiveSection('accounts');
    useLayoutStore.getState().setRoute('settings');
    return;
  }
  if (intent.kind === 'compose') {
    const account = await activeAccount();
    if (account) {
      useLayoutStore.getState().setRoute('mail');
      openNewMessage(account.id, account.email);
    }
    return;
  }
  if (intent.kind === 'mailto') {
    const account = await activeAccount();
    if (account) {
      useLayoutStore.getState().setRoute('mail');
      openNewMessage(account.id, account.email, intent.mailto);
    }
    return;
  }
  if (intent.kind === 'openFolder') {
    useLayoutStore.getState().setRoute('mail');
    useSelectionStore.getState().setActiveAccountId(intent.accountId);
    useSelectionStore.getState().setActiveMailboxId('INBOX');
    return;
  }
  if (intent.kind === 'openThread') {
    useLayoutStore.getState().setRoute('mail');
    const selection = useSelectionStore.getState();
    selection.setActiveAccountId(intent.accountId);
    selection.setActiveMailboxId('INBOX');
    selection.setActiveThreadId(intent.threadId);
    selection.setFlashThreadId(intent.threadId);
    await invoke('mark_thread_read', { accountId: intent.accountId, threadId: intent.threadId });
    return;
  }
  if (intent.kind === 'syncNow') {
    const account = await activeAccount();
    if (account) await invoke('trigger_sync', { accountId: account.id });
  }
}
