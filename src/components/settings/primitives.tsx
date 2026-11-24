import type { ReactNode } from 'react';
import { Switch } from 'radix-ui';
import { Search } from 'lucide-react';
import { TextInput } from '@/components/shared/TextInput';
import { ICON_SIZE } from '@/components/shared/icon-size';

export function SettingSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      className="relative h-5.5 w-9.5 shrink-0 cursor-pointer rounded-full bg-settings-outline-variant transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary data-[state=checked]:bg-settings-primary dark:bg-dark-settings-outline-variant dark:data-[state=checked]:bg-dark-settings-primary"
    >
      <Switch.Thumb className="absolute left-0.75 top-0.75 block size-4 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
    </Switch.Root>
  );
}

export function SubsectionHeading({ children }: { children: string }) {
  return (
    <h3 className="mb-1.5 text-label-md uppercase text-settings-ink-mute dark:text-dark-settings-ink-mute">
      {children}
    </h3>
  );
}

export function SettingsDivider({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={`h-px bg-settings-outline-variant opacity-70 dark:bg-dark-settings-outline-variant ${className}`}
    />
  );
}

export function StatusPip({ className }: { className: string }) {
  return <span aria-hidden="true" className={`size-1.75 rounded-full ${className}`} />;
}

export function SettingsStateText({
  tone = 'muted',
  role,
  children,
}: {
  tone?: 'muted' | 'error';
  role?: 'alert';
  children: ReactNode;
}) {
  const toneClass =
    tone === 'error'
      ? 'text-settings-error dark:text-dark-settings-error'
      : 'text-settings-ink-mute dark:text-dark-settings-ink-mute';
  return (
    <p role={role} className={`px-4 py-8 text-center text-body-sm ${toneClass}`}>
      {children}
    </p>
  );
}

export function HighlightedText({
  text,
  needle,
  caseInsensitive = true,
}: {
  text: string;
  needle: string;
  caseInsensitive?: boolean;
}) {
  if (!needle) return <>{text}</>;
  const haystack = caseInsensitive ? text.toLowerCase() : text;
  const query = caseInsensitive ? needle.toLowerCase() : needle;
  const index = haystack.indexOf(query);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-settings-primary-container px-px text-settings-on-primary-container dark:bg-dark-settings-primary-container dark:text-dark-settings-on-primary-container">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

export function SettingsSearchInput({
  value,
  ariaLabel,
  placeholder,
  onChange,
  className = 'w-52.5',
}: {
  value: string;
  ariaLabel: string;
  placeholder: string;
  onChange: (next: string) => void;
  className?: string;
}) {
  return (
    <label
      className={`flex h-8.5 items-center gap-1.75 rounded-control border border-transparent bg-settings-container-low px-2.5 text-settings-ink-mute focus-within:border-settings-primary dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute dark:focus-within:border-dark-settings-primary ${className}`}
    >
      <Search aria-hidden="true" size={ICON_SIZE.sm} className="shrink-0" />
      <TextInput
        type="search"
        value={value}
        aria-label={ariaLabel}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        variant="bare"
        className="w-full text-settings-desc text-settings-ink placeholder:text-settings-ink-mute dark:text-dark-settings-ink dark:placeholder:text-dark-settings-ink-mute"
      />
    </label>
  );
}
