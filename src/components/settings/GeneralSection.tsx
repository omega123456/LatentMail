import { Switch } from 'radix-ui';
import { minutesToSeconds, secondsToMinutes } from 'date-fns';
import { useLayoutStore } from '@/stores/layout';
import { useThemeStore } from '@/stores/theme';
import type { Density, LayoutMode, ThemePreference } from '@/lib/types/ipc';
import { DensityGlyph, LayoutGlyph } from './LayoutGlyph';
import { SegmentedControl } from './SegmentedControl';
import { SettingRow } from './SettingRow';
import { SettingsSection } from './SettingsSection';

const themeOptions: { value: ThemePreference; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
];

const layoutOptions: { value: LayoutMode; label: string }[] = [
  { value: 'three-column', label: 'Three-column' },
  { value: 'bottom-preview', label: 'Bottom preview' },
  { value: 'list-only', label: 'List only' },
];

const intervalOptionsMinutes = [1, 2, 5, 10, 15, 30];

const densityOptions: { value: Density; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'spacious', label: 'Spacious' },
];

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

export function GeneralSection() {
  const theme = useThemeStore((state) => state.theme);
  const setTheme = useThemeStore((state) => state.setTheme);
  const layout = useLayoutStore((state) => state.layout);
  const setLayout = useLayoutStore((state) => state.setLayout);
  const density = useLayoutStore((state) => state.density);
  const setDensity = useLayoutStore((state) => state.setDensity);
  const showSenderAvatars = useLayoutStore((state) => state.showSenderAvatars);
  const setShowSenderAvatars = useLayoutStore((state) => state.setShowSenderAvatars);
  const showUnreadCounts = useLayoutStore((state) => state.showUnreadCounts);
  const setShowUnreadCounts = useLayoutStore((state) => state.setShowUnreadCounts);
  const syncOnStartup = useLayoutStore((state) => state.syncOnStartup);
  const setSyncOnStartup = useLayoutStore((state) => state.setSyncOnStartup);
  const syncIntervalSeconds = useLayoutStore((state) => state.syncIntervalSeconds);
  const setSyncIntervalSeconds = useLayoutStore((state) => state.setSyncIntervalSeconds);

  return (
    <SettingsSection title="General" description="Changes apply immediately.">
      <div className="flex flex-col">
        <SubsectionHeading>Appearance</SubsectionHeading>
        <SettingRow label="Theme" description="Follow the system or pick one.">
          <SegmentedControl
            ariaLabel="Theme"
            value={theme}
            onChange={setTheme}
            options={themeOptions}
          />
        </SettingRow>
        <SettingRow label="Mail layout" description="Where the reading pane sits.">
          <SegmentedControl
            ariaLabel="Mail layout"
            value={layout}
            onChange={setLayout}
            options={layoutOptions.map((option) => ({
              ...option,
              glyph: <LayoutGlyph layout={option.value} />,
            }))}
          />
        </SettingRow>
        <SettingRow label="Message density" description="Row height in the message list.">
          <SegmentedControl
            ariaLabel="Message density"
            value={density}
            onChange={setDensity}
            options={densityOptions.map((option) => ({
              ...option,
              glyph: <DensityGlyph density={option.value} />,
            }))}
          />
        </SettingRow>
        <SettingRow label="Show sender avatars" description="Display a picture beside each sender.">
          <SettingSwitch
            checked={showSenderAvatars}
            onChange={setShowSenderAvatars}
            label="Show sender avatars"
          />
        </SettingRow>
        <SettingRow
          label="Show unread counts"
          description="Numbers beside mailboxes in the sidebar."
        >
          <SettingSwitch
            checked={showUnreadCounts}
            onChange={setShowUnreadCounts}
            label="Show unread counts"
          />
        </SettingRow>
      </div>
      <div
        aria-hidden="true"
        className="h-px bg-settings-outline-variant opacity-70 dark:bg-dark-settings-outline-variant"
      />
      <div className="flex flex-col">
        <SubsectionHeading>Synchronisation</SubsectionHeading>
        <SettingRow
          label="Sync when LatentMail starts"
          description="Fetch new mail as soon as the app opens."
        >
          <SettingSwitch
            checked={syncOnStartup}
            onChange={setSyncOnStartup}
            label="Sync when LatentMail starts"
          />
        </SettingRow>
        <SettingRow
          label="Full sync every"
          description="New mail arrives as soon as it is detected, regardless of this setting."
        >
          <select
            aria-label="Full sync every"
            value={secondsToMinutes(syncIntervalSeconds)}
            onChange={(event) =>
              setSyncIntervalSeconds(minutesToSeconds(Number(event.target.value)))
            }
            className="cursor-pointer rounded-control bg-settings-container-low px-3.25 py-2 text-settings-desc font-medium text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary dark:bg-dark-settings-container-low dark:text-dark-settings-ink"
          >
            {intervalOptionsMinutes.map((minutes) => (
              <option key={minutes} value={minutes}>
                {minutes} {minutes === 1 ? 'minute' : 'minutes'}
              </option>
            ))}
          </select>
        </SettingRow>
      </div>
    </SettingsSection>
  );
}
