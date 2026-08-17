export const navRow = (active: boolean) =>
  `relative flex cursor-pointer items-center gap-2.5 rounded px-3 py-2 text-body-sm focus-visible:outline-2 focus-visible:outline-primary ${active ? 'bg-surface-container-high font-semibold text-on-surface dark:bg-dark-surface-container-high dark:text-dark-on-surface' : 'text-on-surface-variant hover:bg-surface-container-low dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container'}`;

export const navRail =
  'absolute inset-y-1.5 left-0 w-accent-border rounded-full bg-primary dark:bg-dark-primary';

export const navCount = 'text-label-sm tabular-nums';
