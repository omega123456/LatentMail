import { useEffect, useState } from 'react';
import { CircleAlert, CircleCheck, X } from 'lucide-react';
import { Toast as ToastPrimitive } from 'radix-ui';
import { addMilliseconds, isFuture, milliseconds } from 'date-fns';
import { useToastStore, type Toast as ToastEntry, type ToastSeverity } from '@/stores/toast';

const DURATION_MS: Record<ToastSeverity, number> = {
  success: milliseconds({ seconds: 4 }),
  error: milliseconds({ seconds: 30 }),
};

const VARIANT: Record<
  ToastSeverity,
  { icon: typeof CircleCheck; edge: string; tint: string; rail: string; run: string; hold: string }
> = {
  success: {
    icon: CircleCheck,
    edge: 'border-l-success dark:border-l-dark-success',
    tint: 'text-success dark:text-dark-success',
    rail: 'bg-success dark:bg-dark-success',
    run: 'animate-toast-success',
    hold: 'animate-toast-success-hold',
  },
  error: {
    icon: CircleAlert,
    edge: 'border-l-error dark:border-l-dark-error',
    tint: 'text-error dark:text-dark-error',
    rail: 'bg-error dark:bg-dark-error',
    run: 'animate-toast-error',
    hold: 'animate-toast-error-hold',
  },
};

function ToastCard({ toast }: { toast: ToastEntry }) {
  const dismiss = useToastStore((state) => state.dismiss);
  const [paused, setPaused] = useState(false);
  const variant = VARIANT[toast.severity];
  const Icon = variant.icon;

  useEffect(() => {
    const expiry = addMilliseconds(new Date(), DURATION_MS[toast.severity]);
    const dismissWhenExpired = () => {
      if (!isFuture(expiry)) dismiss(toast.id);
    };
    window.addEventListener('focus', dismissWhenExpired);
    return () => window.removeEventListener('focus', dismissWhenExpired);
  }, [dismiss, toast.id, toast.severity]);

  return (
    <ToastPrimitive.Root
      duration={DURATION_MS[toast.severity]}
      type={toast.severity === 'error' ? 'foreground' : 'background'}
      onOpenChange={(open) => {
        if (!open) dismiss(toast.id);
      }}
      onPause={() => setPaused(true)}
      onResume={() => setPaused(false)}
      data-testid="toast"
      className={`relative flex w-toast-max items-start gap-3 overflow-hidden rounded-md border-l-3 bg-surface-container-lowest py-4.5 pr-3.5 pl-4 shadow-md motion-safe:animate-toast-enter dark:bg-dark-surface-container ${variant.edge}`}
    >
      <Icon aria-hidden="true" size={16} className={`mt-px shrink-0 ${variant.tint}`} />
      <ToastPrimitive.Description className="flex-1 text-body-sm text-on-surface dark:text-dark-on-surface">
        {toast.message}
      </ToastPrimitive.Description>
      <ToastPrimitive.Close
        aria-label="Dismiss"
        className="shrink-0 rounded-sm text-on-surface-variant opacity-60 hover:bg-surface-container-high hover:opacity-100 focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container-high"
      >
        <X aria-hidden="true" size={15} />
      </ToastPrimitive.Close>
      <span
        aria-hidden="true"
        data-testid="toast-rail"
        className={`absolute inset-x-0 bottom-0 h-0.5 origin-left ${variant.rail} ${paused ? variant.hold : variant.run}`}
      />
    </ToastPrimitive.Root>
  );
}

export function Toast() {
  const toasts = useToastStore((state) => state.toasts);
  return (
    <ToastPrimitive.Provider swipeDirection="right">
      {toasts.map((toast) => (
        <ToastCard key={toast.id} toast={toast} />
      ))}
      <ToastPrimitive.Viewport className="fixed top-16 right-0 z-50 m-0 flex list-none flex-col-reverse gap-stack-gap-sm p-container-padding outline-none" />
    </ToastPrimitive.Provider>
  );
}
