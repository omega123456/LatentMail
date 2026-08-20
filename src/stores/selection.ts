import { create } from 'zustand';
import { useComposeStore } from './compose';
import { useMultiSelectStore } from './multi-select';
import { useSearchStore } from './search';

type SelectionState = {
  activeAccountId: string | null;
  activeMailboxId: string | null;
  activeThreadId: string | null;
  keyboardCursor: number | null;
  imagesAllowedFor: string[];
  flashThreadId: string | null;
  allowImagesFor: (messageId: string) => void;
  setActiveAccountId: (activeAccountId: string | null) => void;
  setActiveMailboxId: (activeMailboxId: string | null) => void;
  setActiveThreadId: (activeThreadId: string | null) => void;
  setKeyboardCursor: (keyboardCursor: number | null) => void;
  setFlashThreadId: (threadId: string | null) => void;
  clearSelection: () => void;
  clearStateForRemovedAccount: (accountId: string) => void;
};

export const useSelectionStore = create<SelectionState>((set, get) => ({
  activeAccountId: null,
  activeMailboxId: null,
  activeThreadId: null,
  keyboardCursor: null,
  imagesAllowedFor: [],
  flashThreadId: null,
  allowImagesFor: (messageId) =>
    set((state) =>
      state.imagesAllowedFor.includes(messageId)
        ? state
        : { imagesAllowedFor: [...state.imagesAllowedFor, messageId] },
    ),
  setActiveAccountId: (activeAccountId) => {
    useMultiSelectStore.getState().clear();
    set({ activeAccountId, flashThreadId: null });
  },
  setActiveMailboxId: (activeMailboxId) => {
    useMultiSelectStore.getState().clear();
    set({
      activeMailboxId,
      activeThreadId: null,
      keyboardCursor: null,
      imagesAllowedFor: [],
      flashThreadId: null,
    });
  },
  setActiveThreadId: (activeThreadId) => {
    if (activeThreadId !== null) useMultiSelectStore.getState().clear();
    set({
      activeThreadId,
      imagesAllowedFor: [],
      flashThreadId: get().flashThreadId === activeThreadId ? activeThreadId : null,
    });
  },
  setKeyboardCursor: (keyboardCursor) => set({ keyboardCursor }),
  setFlashThreadId: (flashThreadId) => set({ flashThreadId }),
  clearSelection: () =>
    set({ activeThreadId: null, keyboardCursor: null, imagesAllowedFor: [], flashThreadId: null }),
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
        imagesAllowedFor: [],
        flashThreadId: null,
      });
    }
  },
}));
