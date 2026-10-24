import { create } from 'zustand';

export type MessageSourceTarget = { accountId: string; messageId: string };

type MessageSourceState = {
  target: MessageSourceTarget | null;
  open: (target: MessageSourceTarget) => void;
  close: () => void;
};

export const useMessageSourceStore = create<MessageSourceState>((set) => ({
  target: null,
  open: (target) => set({ target }),
  close: () => set({ target: null }),
}));
