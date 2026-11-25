import { create } from 'zustand';
import { useAssistantStore } from './assistant';
import { useMultiSelectStore } from './multi-select';

type ThreadSelection = {
  activeThreadId: string | null;
  keyboardCursor: number | null;
  imagesAllowedFor: string[];
  flashThreadId: string | null;
};

type AccountSelection = ThreadSelection & {
  activeAccountId: string | null;
  activeMailboxId: string | null;
};

export const CLEARED_SELECTION: ThreadSelection = {
  activeThreadId: null,
  keyboardCursor: null,
  imagesAllowedFor: [],
  flashThreadId: null,
};

export const CLEARED_ACCOUNT_SELECTION: AccountSelection = {
  activeAccountId: null,
  activeMailboxId: null,
  ...CLEARED_SELECTION,
};

type SelectionState = AccountSelection & {
  allowImagesFor: (messageId: string) => void;
  setActiveAccountId: (activeAccountId: string | null) => void;
  setActiveMailboxId: (activeMailboxId: string | null) => void;
  setActiveThreadId: (activeThreadId: string | null) => void;
  setKeyboardCursor: (keyboardCursor: number | null) => void;
  setFlashThreadId: (threadId: string | null) => void;
  clearSelection: () => void;
  clearAccount: () => void;
};

function appendAllowedImageMessage(imagesAllowedFor: string[], messageId: string): string[] {
  if (imagesAllowedFor.includes(messageId)) return imagesAllowedFor;
  return [...imagesAllowedFor, messageId];
}

export const useSelectionStore = create<SelectionState>((set, get) => ({
  ...CLEARED_ACCOUNT_SELECTION,
  allowImagesFor: (messageId) =>
    set((state) => ({
      imagesAllowedFor: appendAllowedImageMessage(state.imagesAllowedFor, messageId),
    })),
  setActiveAccountId: (activeAccountId) => {
    useMultiSelectStore.getState().clear();
    if (activeAccountId !== null) useAssistantStore.getState().selectAccount(activeAccountId);
    set({ activeAccountId: activeAccountId, flashThreadId: null });
  },
  setActiveMailboxId: (activeMailboxId) => {
    useMultiSelectStore.getState().clear();
    set({ activeMailboxId: activeMailboxId, ...CLEARED_SELECTION });
  },
  setActiveThreadId: (activeThreadId) => {
    if (activeThreadId !== null) useMultiSelectStore.getState().clear();
    const keepFlash = get().flashThreadId === activeThreadId;
    set({
      activeThreadId: activeThreadId,
      imagesAllowedFor: [],
      flashThreadId: keepFlash ? activeThreadId : null,
    });
  },
  setKeyboardCursor: (keyboardCursor) => set({ keyboardCursor }),
  setFlashThreadId: (flashThreadId) => set({ flashThreadId }),
  clearSelection: () => set({ ...CLEARED_SELECTION }),
  clearAccount: () => set({ ...CLEARED_ACCOUNT_SELECTION }),
}));
