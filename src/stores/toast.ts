import { create } from 'zustand';

export type ToastSeverity = 'success' | 'error';
export type Toast = { id: number; severity: ToastSeverity; message: string };

/** Newest last, oldest dropped past the cap. A flaky-network burst can fail a
 * dozen operations in a second; without a cap that grows an unbounded column
 * up the left edge of the window. Callers that already know they are acting on
 * many items should coalesce into one message rather than rely on this. */
export const MAX_VISIBLE_TOASTS = 3;

type ToastState = {
  toasts: Toast[];
  showSuccess: (message: string) => void;
  showError: (message: string) => void;
  dismiss: (id: number) => void;
};

let nextId = 0;

export const useToastStore = create<ToastState>((set) => {
  const push = (severity: ToastSeverity, message: string) =>
    set((state) => ({
      toasts: [...state.toasts, { id: nextId++, severity, message }].slice(-MAX_VISIBLE_TOASTS),
    }));
  return {
    toasts: [],
    showSuccess: (message) => push('success', message),
    showError: (message) => push('error', message),
    dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
  };
});
