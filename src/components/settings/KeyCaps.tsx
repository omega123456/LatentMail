import { Fragment } from 'react';
import { formatBindingParts, isMacPlatform, primaryBinding } from '@/lib/keyboard/format';

function KeyCap({ children }: { children: string }) {
  return (
    <kbd className="min-w-5.25 rounded-keycap border border-settings-outline-variant bg-settings-container-low px-1.5 py-0.75 text-center text-settings-keycap text-settings-ink dark:border-dark-settings-outline-variant dark:bg-dark-settings-container-low dark:text-dark-settings-ink">
      {children}
    </kbd>
  );
}

export function KeyCaps({ bindings }: { bindings: string[] }) {
  const isMac = isMacPlatform();
  const binding = primaryBinding(bindings, isMac);
  if (binding === null) {
    return (
      <span className="text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
        Not set
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      {formatBindingParts(binding, isMac).map((part, index) => (
        <Fragment key={`${part}-${index}`}>
          {index > 0 && (
            <span
              aria-hidden="true"
              className="text-settings-joiner text-settings-outline dark:text-dark-settings-outline"
            >
              +
            </span>
          )}
          <KeyCap>{part}</KeyCap>
        </Fragment>
      ))}
    </span>
  );
}
