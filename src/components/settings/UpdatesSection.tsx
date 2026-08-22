import { Switch } from 'radix-ui';
import { format, formatDistanceToNow } from 'date-fns';
import { useAppUpdateQuery, useInstallUpdateMutation } from '@/lib/query/hooks';
import { useLayoutStore } from '@/stores/layout';
import { useToastStore } from '@/stores/toast';
import { Select } from '@/components/shared/Select';
import { SettingRow } from './SettingRow';
import { settingsButton, settingsTriggerClass } from './styles';
import { SettingsSection } from './SettingsSection';
import { UPDATE_INTERVAL_OPTIONS } from '@/lib/update-intervals';

function SettingSwitch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      className="relative h-5.5 w-9.5 shrink-0 cursor-pointer rounded-full bg-settings-outline-variant transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary data-[state=checked]:bg-settings-primary dark:bg-dark-settings-outline-variant dark:data-[state=checked]:bg-dark-settings-primary"
    >
      <Switch.Thumb className="absolute left-0.75 top-0.75 block size-4 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
    </Switch.Root>
  );
}

function SubsectionHeading({ children }: { children: string }) {
  return (
    <h3 className="mb-1.5 text-label-md uppercase text-settings-ink-mute dark:text-dark-settings-ink-mute">
      {children}
    </h3>
  );
}

export function UpdatesSection() {
  const { data, dataUpdatedAt, isFetching, refetch } = useAppUpdateQuery();
  const installMutation = useInstallUpdateMutation();
  const showSuccess = useToastStore((state) => state.showSuccess);
  const showError = useToastStore((state) => state.showError);
  const updateCheckInterval = useLayoutStore((state) => state.updateCheckInterval);
  const setUpdateCheckInterval = useLayoutStore((state) => state.setUpdateCheckInterval);
  const installUpdateOnQuit = useLayoutStore((state) => state.installUpdateOnQuit);
  const setInstallUpdateOnQuit = useLayoutStore((state) => state.setInstallUpdateOnQuit);

  const available = data?.available ?? null;
  const currentVersion = data?.currentVersion ?? '…';
  const notes = available?.notes?.split('\n').filter(Boolean) ?? [];

  return (
    <SettingsSection
      title="Updates"
      description="LatentMail checks GitHub Releases for new versions."
    >
      <div
        data-testid="updates-status"
        className={`flex items-center justify-between gap-4 rounded-control border px-4 py-3.5 ${
          available
            ? 'border-settings-primary-container bg-settings-primary-container dark:border-dark-settings-primary-container dark:bg-dark-settings-primary-container'
            : 'border-settings-outline-variant bg-settings-container-low dark:border-dark-settings-outline-variant dark:bg-dark-settings-container-low'
        }`}
      >
        <div className="flex flex-col gap-0.5">
          <span className="flex items-center gap-2 text-body-sm font-semibold text-settings-ink dark:text-dark-settings-ink">
            {!available && (
              <span
                aria-hidden="true"
                className="size-1.75 rounded-full bg-success dark:bg-dark-success"
              />
            )}
            {available
              ? `LatentMail ${available.version} is available`
              : `LatentMail ${currentVersion}`}
          </span>
          <span className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
            {available
              ? `You have ${currentVersion}${
                  available.dateMillis
                    ? ` · released ${format(new Date(available.dateMillis), 'd MMMM yyyy')}`
                    : ''
                }`
              : dataUpdatedAt
                ? `Up to date · checked ${formatDistanceToNow(dataUpdatedAt, { addSuffix: true })}`
                : 'Checking for updates…'}
          </span>
        </div>
        {available ? (
          <button
            type="button"
            onClick={() => installMutation.mutate()}
            disabled={installMutation.isPending}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-control bg-settings-primary px-3.75 py-2.25 text-settings-desc font-semibold text-on-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary disabled:cursor-not-allowed disabled:opacity-60 dark:bg-dark-settings-primary dark:text-dark-on-primary"
          >
            {installMutation.isPending ? 'Installing…' : 'Install and restart'}
          </button>
        ) : (
          <button
            type="button"
            onClick={() =>
              void refetch().then((result) => {
                if (result.status === 'error') {
                  showError('Couldn’t check for updates.');
                } else if (!result.data?.available) {
                  showSuccess(`LatentMail ${result.data?.currentVersion} is up to date.`);
                }
              })
            }
            disabled={isFetching}
            className={`shrink-0 ${settingsButton} disabled:cursor-not-allowed disabled:opacity-60`}
          >
            {isFetching ? 'Checking…' : 'Check now'}
          </button>
        )}
      </div>

      {notes.length > 0 && (
        <div
          data-testid="updates-notes"
          className="flex flex-col gap-2 rounded-control bg-settings-container-low px-4 py-3.5 dark:bg-dark-settings-container-low"
        >
          <p className="text-settings-desc font-semibold text-settings-ink dark:text-dark-settings-ink">
            What is new in {available?.version}
          </p>
          <ul className="flex flex-col gap-1 text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
            {notes.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-col">
        <SubsectionHeading>Automatic checks</SubsectionHeading>
        <SettingRow
          label="Check for updates"
          description="How often LatentMail looks for a new version."
        >
          <Select
            ariaLabel="Check for updates"
            value={updateCheckInterval}
            onChange={setUpdateCheckInterval}
            options={UPDATE_INTERVAL_OPTIONS}
            className={settingsTriggerClass}
          />
        </SettingRow>
        <SettingRow
          label="Install on quit"
          description="Apply a downloaded update the next time you close LatentMail."
        >
          <SettingSwitch
            checked={installUpdateOnQuit}
            onChange={setInstallUpdateOnQuit}
            label="Install on quit"
          />
        </SettingRow>
      </div>
      <div
        aria-hidden="true"
        className="h-px bg-settings-outline-variant opacity-70 dark:bg-dark-settings-outline-variant"
      />
      <div className="flex flex-col">
        <SubsectionHeading>This build</SubsectionHeading>
        <dl className="flex flex-col">
          <div className="flex items-center justify-between py-1.5">
            <dt className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
              Version
            </dt>
            <dd className="font-mono text-settings-desc text-settings-ink dark:text-dark-settings-ink">
              {currentVersion}
            </dd>
          </div>
          <div className="flex items-center justify-between py-1.5">
            <dt className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
              Update feed
            </dt>
            <dd className="font-mono text-settings-desc text-settings-ink dark:text-dark-settings-ink">
              omega123456/LatentMail
            </dd>
          </div>
        </dl>
      </div>
    </SettingsSection>
  );
}
