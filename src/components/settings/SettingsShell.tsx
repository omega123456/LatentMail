import type { ComponentType } from 'react';
import { useLayoutStore } from '@/stores/layout';
import { useSettingsUiStore, type SettingsSectionId } from '@/stores/settings-ui';
import { QueueSection } from '@/components/queue/QueueSection';
import { AccountsSection } from './AccountsSection';
import { AiSection } from './AiSection';
import { GeneralSection } from './GeneralSection';
import { KeyboardSection } from './KeyboardSection';
import { LogsSection } from './LogsSection';
import { SettingsNav } from './SettingsNav';
import { UpdatesSection } from './UpdatesSection';

const CONSTRAINED_CONTAINER_CLASS =
  'mx-auto flex w-full max-w-settings-content-max flex-col gap-5.5';
const FULL_HEIGHT_CONTAINER_CLASS = 'flex min-h-0 min-w-0 flex-1 flex-col gap-5.5';

const SECTION_VIEWS: Record<
  SettingsSectionId,
  { testId: string; containerClass: string; Component: ComponentType }
> = {
  general: {
    testId: 'settings-general-section',
    containerClass: CONSTRAINED_CONTAINER_CLASS,
    Component: GeneralSection,
  },
  accounts: {
    testId: 'settings-accounts-section',
    containerClass: CONSTRAINED_CONTAINER_CLASS,
    Component: AccountsSection,
  },
  ai: {
    testId: 'settings-ai-section',
    containerClass: CONSTRAINED_CONTAINER_CLASS,
    Component: AiSection,
  },
  keyboard: {
    testId: 'settings-keyboard-section',
    containerClass: CONSTRAINED_CONTAINER_CLASS,
    Component: KeyboardSection,
  },
  queue: {
    testId: 'settings-queue-section',
    containerClass: CONSTRAINED_CONTAINER_CLASS,
    Component: QueueSection,
  },
  logs: {
    testId: 'settings-logs-section',
    containerClass: FULL_HEIGHT_CONTAINER_CLASS,
    Component: LogsSection,
  },
  updates: {
    testId: 'settings-updates-section',
    containerClass: CONSTRAINED_CONTAINER_CLASS,
    Component: UpdatesSection,
  },
};

export function SettingsShell() {
  const setRoute = useLayoutStore((layout) => layout.setRoute);
  const activeSection = useSettingsUiStore((settingsUi) => settingsUi.activeSection);
  const setActiveSection = useSettingsUiStore((settingsUi) => settingsUi.setActiveSection);
  const section = SECTION_VIEWS[activeSection];
  const SectionComponent = section.Component;

  return (
    <div
      data-testid="settings-shell"
      className="flex h-full min-w-0 bg-settings-page dark:bg-dark-settings-page"
    >
      <SettingsNav
        activeSection={activeSection}
        onSelectSection={setActiveSection}
        onBackToMail={() => setRoute('mail')}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5.5 overflow-y-auto px-8.5 pb-8.5 pt-7.5">
        <div data-testid={section.testId} className={section.containerClass}>
          <SectionComponent />
        </div>
      </div>
    </div>
  );
}
