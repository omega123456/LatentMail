import { useAssistantStore } from '@/stores/assistant';
import { useComposeStore } from '@/stores/compose';
import { useMultiSelectStore } from '@/stores/multi-select';
import { useSearchStore } from '@/stores/search';
import { useSelectionStore } from '@/stores/selection';

export function clearStateForRemovedAccount(accountId: string) {
  useMultiSelectStore.getState().clear();
  useSearchStore.getState().clear();
  const composeSession = useComposeStore.getState().session;
  if (composeSession?.accountId === accountId) useComposeStore.getState().close();
  if (useAssistantStore.getState().accountId === accountId) {
    useAssistantStore.getState().detachAccount();
  }
  if (useSelectionStore.getState().activeAccountId === accountId) {
    useSelectionStore.getState().clearAccount();
  }
}
