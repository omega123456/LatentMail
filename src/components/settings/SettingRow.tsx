import type { ReactNode } from 'react';

export function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-8 py-3.25">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-body-sm font-medium text-settings-ink dark:text-dark-settings-ink">
          {label}
        </span>
        <span className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
          {description}
        </span>
      </div>
      {children}
    </div>
  );
}
