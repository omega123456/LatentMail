import { AlertTriangle, RefreshCw, type LucideIcon } from 'lucide-react';

const icons = { warning: AlertTriangle, rebuild: RefreshCw } satisfies Record<string, LucideIcon>;

export function InlineConfirm({
  icon = 'warning',
  title,
  body,
  action,
  onConfirm,
  onCancel,
}: {
  icon?: keyof typeof icons;
  title: string;
  body: string;
  action: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const Icon = icons[icon];
  return (
    <div
      role="alert"
      className="flex flex-col gap-2.5 rounded-control border border-settings-error-container bg-settings-error-container px-3.5 py-3 text-settings-on-error-container dark:border-dark-settings-error-container dark:bg-dark-settings-error-container dark:text-dark-settings-on-error-container"
    >
      <p className="flex items-center gap-2 text-settings-desc font-semibold">
        <Icon aria-hidden="true" size={14} className="shrink-0" />
        {title}
      </p>
      <p className="text-settings-meta opacity-90">{body}</p>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onConfirm}
          className="cursor-pointer rounded-control bg-settings-error px-3.75 py-2.25 text-settings-desc font-semibold text-on-error focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary dark:bg-dark-settings-error dark:text-dark-settings-error-container"
        >
          {action}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer rounded-control px-3.75 py-2.25 text-settings-desc font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
