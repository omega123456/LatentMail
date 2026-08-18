import {
  ArrowLeft,
  Keyboard,
  ListChecks,
  SlidersHorizontal,
  UserCircle,
  type LucideIcon,
} from 'lucide-react';
import type { SettingsSectionId } from '@/stores/settings-ui';

const sections: { id: SettingsSectionId; label: string; Icon: LucideIcon }[] = [
  { id: 'general', label: 'General', Icon: SlidersHorizontal },
  { id: 'accounts', label: 'Accounts', Icon: UserCircle },
  { id: 'keyboard', label: 'Keyboard', Icon: Keyboard },
  { id: 'queue', label: 'Queue', Icon: ListChecks },
];

const navRow = (active: boolean) =>
  `relative flex cursor-pointer items-center gap-2.75 rounded-control px-3.25 py-2.25 text-body-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary ${
    active
      ? 'bg-settings-container-high font-semibold text-settings-ink dark:bg-dark-settings-container-high dark:text-dark-settings-ink'
      : 'text-settings-ink-mute hover:bg-settings-container-low dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container-low'
  }`;

export function SettingsNav({
  activeSection,
  onSelectSection,
  onBackToMail,
}: {
  activeSection: SettingsSectionId;
  onSelectSection: (section: SettingsSectionId) => void;
  onBackToMail: () => void;
}) {
  return (
    <nav
      aria-label="Settings"
      data-testid="settings-nav"
      className="flex w-settings-nav shrink-0 flex-col gap-0.5 bg-settings-nav px-3 py-4 dark:bg-dark-settings-nav"
    >
      <button
        type="button"
        aria-label="Back to Mail"
        onClick={onBackToMail}
        className={navRow(false)}
      >
        <ArrowLeft aria-hidden="true" size={15} />
        <span className="flex-1 text-left">Mail</span>
      </button>
      <div
        aria-hidden="true"
        className="mx-3.25 my-3 h-px bg-settings-outline-variant opacity-70 dark:bg-dark-settings-outline-variant"
      />
      {sections.map(({ id, label, Icon }) => {
        const active = activeSection === id;
        return (
          <button
            key={id}
            type="button"
            aria-current={active ? 'page' : undefined}
            onClick={() => onSelectSection(id)}
            className={navRow(active)}
          >
            {active && (
              <span
                aria-hidden="true"
                className="absolute inset-y-2 left-0 w-0.75 rounded-full bg-settings-primary dark:bg-dark-settings-primary"
              />
            )}
            <Icon aria-hidden="true" size={15} />
            <span className="flex-1 text-left">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}
