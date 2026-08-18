import type { ReactNode } from 'react';

export function SettingsSection({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col gap-5.5">
      <div className="flex items-start justify-between gap-5">
        <div>
          <h2 className="text-settings-title text-settings-ink dark:text-dark-settings-ink">
            {title}
          </h2>
          {description && (
            <p className="mt-1.25 text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
              {description}
            </p>
          )}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
