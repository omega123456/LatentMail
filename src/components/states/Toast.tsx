import { useToastStore } from '@/stores/toast';

export function Toast() {
  const toast = useToastStore((state) => state.toast);
  const dismiss = useToastStore((state) => state.dismiss);
  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex justify-center p-container-padding">
      <div role="alert" className="pointer-events-auto flex items-center gap-3 rounded bg-error px-4 py-3 text-label-md text-on-error shadow-md dark:bg-dark-error dark:text-dark-on-error">
        <span>{toast.message}</span>
        <button aria-label="Dismiss error" onClick={dismiss} className="rounded-sm focus-visible:outline-2 focus-visible:outline-on-error">Dismiss</button>
      </div>
    </div>
  );
}
