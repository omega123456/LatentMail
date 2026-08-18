import { Check, ChevronDown, ChevronUp } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';

export type SelectOption<T extends string> = {
  value: T;
  label: string;
};

const contentClass =
  'z-50 max-h-64 overflow-hidden rounded-md border border-outline-variant/40 bg-surface-container-lowest p-1 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest';
const scrollButtonClass =
  'flex h-5 cursor-default items-center justify-center text-on-surface-variant dark:text-dark-on-surface-variant';
const itemClass =
  'flex cursor-pointer select-none items-center gap-2 rounded-sm px-2 py-1.5 text-body-sm text-on-surface outline-none data-[highlighted]:bg-surface-container-high data-[state=checked]:font-semibold data-[state=checked]:text-primary dark:text-dark-on-surface dark:data-[highlighted]:bg-dark-surface-container-high dark:data-[state=checked]:text-dark-primary';

export function Select<T extends string>({
  id,
  ariaLabel,
  value,
  onChange,
  options,
  className,
}: {
  id?: string;
  ariaLabel?: string;
  value: T;
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  className: string;
}) {
  return (
    <SelectPrimitive.Root value={value} onValueChange={(next) => onChange(next as T)}>
      <SelectPrimitive.Trigger
        id={id}
        aria-label={ariaLabel}
        className={`flex items-center justify-between gap-2 ${className}`}
      >
        <SelectPrimitive.Value />
        <SelectPrimitive.Icon>
          <ChevronDown aria-hidden="true" className="size-4 opacity-70" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          position="popper"
          sideOffset={4}
          className={contentClass}
          style={{ minWidth: 'var(--radix-select-trigger-width, var(--spacing-select-menu))' }}
        >
          <SelectPrimitive.ScrollUpButton className={scrollButtonClass}>
            <ChevronUp aria-hidden="true" className="size-4" />
          </SelectPrimitive.ScrollUpButton>
          <SelectPrimitive.Viewport className="flex flex-col gap-0.5">
            {options.map((option) => (
              <SelectPrimitive.Item key={option.value} value={option.value} className={itemClass}>
                <span className="flex size-4 shrink-0 items-center justify-center">
                  <SelectPrimitive.ItemIndicator>
                    <Check aria-hidden="true" className="size-4" />
                  </SelectPrimitive.ItemIndicator>
                </span>
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
              </SelectPrimitive.Item>
            ))}
          </SelectPrimitive.Viewport>
          <SelectPrimitive.ScrollDownButton className={scrollButtonClass}>
            <ChevronDown aria-hidden="true" className="size-4" />
          </SelectPrimitive.ScrollDownButton>
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}
