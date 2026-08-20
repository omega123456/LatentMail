import { create } from 'zustand';

type UpdateState = {
  dismissedVersion: string | null;
  dismiss: (version: string) => void;
};

export const useUpdateStore = create<UpdateState>((set) => ({
  dismissedVersion: null,
  dismiss: (version) => set({ dismissedVersion: version }),
}));
