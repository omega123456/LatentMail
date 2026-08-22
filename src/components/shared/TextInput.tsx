import type { ComponentPropsWithRef } from 'react';

const variantClass = {
  boxed:
    'select-text rounded border border-outline-variant/50 bg-surface-container-lowest px-2 py-1.5 text-body-sm text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest dark:text-dark-on-surface',
  bare: 'select-text bg-transparent outline-none',
};

export function TextInput({
  variant = 'boxed',
  className,
  ...props
}: ComponentPropsWithRef<'input'> & { variant?: keyof typeof variantClass }) {
  return (
    <input
      type="text"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      {...props}
      className={className ? `${variantClass[variant]} ${className}` : variantClass[variant]}
    />
  );
}
