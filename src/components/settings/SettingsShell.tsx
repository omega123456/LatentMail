import { useLayoutStore } from '@/stores/layout';
import { useSettingsUiStore } from '@/stores/settings-ui';
import { QueueSection } from '@/components/queue/QueueSection';
import { AccountsSection } from './AccountsSection';
import { GeneralSection } from './GeneralSection';
import { KeyboardSection } from './KeyboardSection';
import { LogsSection } from './LogsSection';
import { SettingsNav } from './SettingsNav';
import { UpdatesSection } from './UpdatesSection';

export function SettingsShell() {
  const setRoute = useLayoutStore((state) => state.setRoute);
  const activeSection = useSettingsUiStore((state) => state.activeSection);
  const setActiveSection = useSettingsUiStore((state) => state.setActiveSection);

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
        {activeSection === 'general' && (
          <div
            data-testid="settings-general-section"
            className="mx-auto flex w-full max-w-settings-content-max flex-col gap-5.5"
          >
            <GeneralSection />
          </div>
        )}
        {activeSection === 'accounts' && (
          <div
            data-testid="settings-accounts-section"
            className="mx-auto flex w-full max-w-settings-content-max flex-col gap-5.5"
          >
            <AccountsSection />
          </div>
        )}
        {activeSection === 'keyboard' && (
          <div
            data-testid="settings-keyboard-section"
            className="mx-auto flex w-full max-w-settings-content-max flex-col gap-5.5"
          >
            <KeyboardSection />
          </div>
        )}
        {activeSection === 'queue' && (
          <div
            data-testid="settings-queue-section"
            className="mx-auto flex w-full max-w-settings-content-max flex-col gap-5.5"
          >
            <QueueSection />
          </div>
        )}
        {activeSection === 'logs' && (
          <div
            data-testid="settings-logs-section"
            className="flex min-h-0 min-w-0 flex-1 flex-col gap-5.5"
          >
            <LogsSection />
          </div>
        )}
        {activeSection === 'updates' && (
          <div
            data-testid="settings-updates-section"
            className="mx-auto flex w-full max-w-settings-content-max flex-col gap-5.5"
          >
            <UpdatesSection />
          </div>
        )}
      </div>
    </div>
  );
}
