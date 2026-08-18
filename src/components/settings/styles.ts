export const settingsButton =
  'inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-control bg-settings-container px-3.75 py-2.25 text-settings-desc font-semibold text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary dark:bg-dark-settings-container dark:text-dark-settings-ink';

export const settingsQuietButton =
  'inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-control px-3.75 py-2.25 text-settings-desc font-semibold text-settings-ink-mute hover:bg-settings-container-low hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container-low dark:hover:text-dark-settings-ink';

export const settingsIconButton =
  'grid size-6 shrink-0 cursor-pointer place-items-center rounded-chip text-settings-ink-mute hover:bg-settings-container hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container dark:hover:text-dark-settings-ink';

export const settingsDangerIconButton = `${settingsIconButton} hover:text-settings-error dark:hover:text-dark-settings-error`;

export const settingsLinkButton =
  'cursor-pointer rounded-sm px-1 py-0.5 text-settings-meta font-semibold focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary disabled:cursor-not-allowed disabled:opacity-40';

export const settingsLinkPrimary = `${settingsLinkButton} text-settings-primary dark:text-dark-settings-primary`;

export const settingsLinkMuted = `${settingsLinkButton} text-settings-ink-mute dark:text-dark-settings-ink-mute`;

export const settingsTriggerClass =
  'w-select-menu cursor-pointer rounded-control bg-settings-container-low px-3.25 py-2 text-settings-desc font-medium text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary dark:bg-dark-settings-container-low dark:text-dark-settings-ink';
