import { create } from 'zustand';
import { useMultiSelectStore } from './multi-select';

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
};

export const useSelectionStore = create<SelectionState>((set) => ({
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
}));
