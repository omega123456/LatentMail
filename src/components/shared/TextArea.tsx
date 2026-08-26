import type { ComponentPropsWithRef } from 'react';

const variantClass = {
  boxed:
    'select-text resize-none rounded-control border border-outline-variant/60 bg-surface-container-lowest px-2.5 py-2 text-body-sm text-on-surface focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50 dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest dark:text-dark-on-surface',
  bare: 'select-text resize-none bg-transparent outline-none',
};

export function TextArea({
  variant = 'boxed',
  className,
  ...props
}: ComponentPropsWithRef<'textarea'> & { variant?: keyof typeof variantClass }) {
  return (
    <textarea
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      {...props}
      className={className ? `${variantClass[variant]} ${className}` : variantClass[variant]}
    />
  );
}
