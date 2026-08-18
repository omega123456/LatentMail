import { create } from 'zustand';
import { useComposeStore } from './compose';
import { useMultiSelectStore } from './multi-select';
import { useSearchStore } from './search';

type SelectionState = {
  activeAccountId: string | null;
  activeMailboxId: string | null;
  activeThreadId: string | null;
  keyboardCursor: number | null;
  setActiveAccountId: (activeAccountId: string | null) => void;
  setActiveMailboxId: (activeMailboxId: string | null) => void;
  setActiveThreadId: (activeThreadId: string | null) => void;
  setKeyboardCursor: (keyboardCursor: number | null) => void;
  clearSelection: () => void;
  clearStateForRemovedAccount: (accountId: string) => void;
};

export const useSelectionStore = create<SelectionState>((set, get) => ({
  activeAccountId: null,
  activeMailboxId: null,
  activeThreadId: null,
  keyboardCursor: null,
  setActiveAccountId: (activeAccountId) => {
    useMultiSelectStore.getState().clear();
    set({ activeAccountId });
  },
  setActiveMailboxId: (activeMailboxId) => {
    useMultiSelectStore.getState().clear();
    set({ activeMailboxId, activeThreadId: null, keyboardCursor: null });
  },
  setActiveThreadId: (activeThreadId) => {
    if (activeThreadId !== null) useMultiSelectStore.getState().clear();
    set({ activeThreadId });
  },
  setKeyboardCursor: (keyboardCursor) => set({ keyboardCursor }),
  clearSelection: () => set({ activeThreadId: null, keyboardCursor: null }),
  clearStateForRemovedAccount: (accountId) => {
    useMultiSelectStore.getState().clear();
    useSearchStore.getState().clear();
    const composeSession = useComposeStore.getState().session;
    if (composeSession?.accountId === accountId) useComposeStore.getState().close();
    if (get().activeAccountId === accountId) {
      set({
        activeAccountId: null,
        activeMailboxId: null,
        activeThreadId: null,
        keyboardCursor: null,
      });
    }
  },
}));
