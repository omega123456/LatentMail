import { create } from 'zustand';

type Toast = { id: number; message: string };
type ToastState = {
  toast: Toast | null;
  showError: (message: string) => void;
  showSuccess: (message: string) => void;
  dismiss: () => void;
};

let nextId = 0;
export const useToastStore = create<ToastState>((set) => ({
  toast: null,
  showError: (message) => set({ toast: { id: nextId++, message } }),
  showSuccess: (message) => set({ toast: { id: nextId++, message } }),
  dismiss: () => set({ toast: null }),
}));
