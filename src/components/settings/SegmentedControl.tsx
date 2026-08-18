import { RadioGroup } from 'radix-ui';
import type { ReactNode } from 'react';

export type SegmentOption<T extends string> = {
  value: T;
  label: string;
  glyph?: ReactNode;
};

export function SegmentedControl<T extends string>({
  ariaLabel,
  value,
  onChange,
  options,
}: {
  ariaLabel: string;
  value: T;
  onChange: (value: T) => void;
  options: SegmentOption<T>[];
}) {
  return (
    <RadioGroup.Root
      aria-label={ariaLabel}
      value={value}
      onValueChange={(next) => onChange(next as T)}
      className="inline-flex gap-0.5 rounded-group bg-settings-container-low p-0.75 dark:bg-dark-settings-container-low"
    >
      {options.map((option) => (
        <RadioGroup.Item
          key={option.value}
          value={option.value}
          className="inline-flex cursor-pointer items-center gap-1.75 rounded-chip px-3 py-1.75 text-settings-meta font-semibold text-settings-ink-mute focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary data-[state=checked]:bg-settings-card data-[state=checked]:text-settings-ink data-[state=checked]:shadow-segment dark:text-dark-settings-ink-mute dark:data-[state=checked]:bg-dark-settings-card dark:data-[state=checked]:text-dark-settings-ink"
        >
          {option.glyph}
          {option.label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
