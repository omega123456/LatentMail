import { Switch } from 'radix-ui';
import { minutesToSeconds, secondsToMinutes } from 'date-fns';
import { useLayoutStore } from '@/stores/layout';
import { useThemeStore } from '@/stores/theme';
import type { Density, LayoutMode, ThemePreference } from '@/lib/types/ipc';
import { Select } from '@/components/shared/Select';
import { DensityGlyph, LayoutGlyph } from './LayoutGlyph';
import { SegmentedControl } from './SegmentedControl';
import { SettingRow } from './SettingRow';
import { settingsTriggerClass } from './styles';
import { SettingsSection } from './SettingsSection';
import { TrustedSendersList } from './TrustedSendersList';
import { isWindows } from '@/lib/os/platform';

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

const zoomOptionsPercent = [80, 90, 100, 110, 125, 150];

const densityOptions: { value: Density; label: string }[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'spacious', label: 'Spacious' },
];

export function SettingSwitch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <Switch.Root
      checked={checked}
      onCheckedChange={onChange}
      aria-label={label}
      disabled={disabled}
      className="relative h-5.5 w-9.5 shrink-0 cursor-pointer rounded-full bg-settings-outline-variant transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary data-[state=checked]:bg-settings-primary dark:bg-dark-settings-outline-variant dark:data-[state=checked]:bg-dark-settings-primary"
    >
      <Switch.Thumb className="absolute left-0.75 top-0.75 block size-4 rounded-full bg-white transition-transform data-[state=checked]:translate-x-4" />
    </Switch.Root>
  );
}

export function SubsectionHeading({ children }: { children: string }) {
  return (
    <h3 className="mb-1.5 text-label-md uppercase text-settings-ink-mute dark:text-dark-settings-ink-mute">
      {children}
    </h3>
  );
}

export function GeneralSection() {
  const theme = useThemeStore((themeState) => themeState.theme);
  const setTheme = useThemeStore((themeState) => themeState.setTheme);
  const layout = useLayoutStore((layoutState) => layoutState.layout);
  const setLayout = useLayoutStore((layoutState) => layoutState.setLayout);
  const density = useLayoutStore((layoutState) => layoutState.density);
  const setDensity = useLayoutStore((layoutState) => layoutState.setDensity);
  const showSenderAvatars = useLayoutStore((layoutState) => layoutState.showSenderAvatars);
  const setShowSenderAvatars = useLayoutStore((layoutState) => layoutState.setShowSenderAvatars);
  const zoomPercent = useLayoutStore((layoutState) => layoutState.zoomPercent);
  const setZoomPercent = useLayoutStore((layoutState) => layoutState.setZoomPercent);
  const showUnreadCounts = useLayoutStore((layoutState) => layoutState.showUnreadCounts);
  const setShowUnreadCounts = useLayoutStore((layoutState) => layoutState.setShowUnreadCounts);
  const syncOnStartup = useLayoutStore((layoutState) => layoutState.syncOnStartup);
  const setSyncOnStartup = useLayoutStore((layoutState) => layoutState.setSyncOnStartup);
  const syncIntervalSeconds = useLayoutStore((layoutState) => layoutState.syncIntervalSeconds);
  const setSyncIntervalSeconds = useLayoutStore(
    (layoutState) => layoutState.setSyncIntervalSeconds,
  );
  const alwaysLoadRemoteImages = useLayoutStore(
    (layoutState) => layoutState.alwaysLoadRemoteImages,
  );
  const setAlwaysLoadRemoteImages = useLayoutStore(
    (layoutState) => layoutState.setAlwaysLoadRemoteImages,
  );
  const prefetchImageAttachments = useLayoutStore(
    (layoutState) => layoutState.prefetchImageAttachments,
  );
  const setPrefetchImageAttachments = useLayoutStore(
    (layoutState) => layoutState.setPrefetchImageAttachments,
  );
  const startAtLogin = useLayoutStore((layoutState) => layoutState.startAtLogin);
  const setStartAtLogin = useLayoutStore((layoutState) => layoutState.setStartAtLogin);
  const closeToTray = useLayoutStore((layoutState) => layoutState.closeToTray);
  const setCloseToTray = useLayoutStore((layoutState) => layoutState.setCloseToTray);
  const startMinimized = useLayoutStore((layoutState) => layoutState.startMinimized);
  const setStartMinimized = useLayoutStore((layoutState) => layoutState.setStartMinimized);
  const desktopNotifications = useLayoutStore((layoutState) => layoutState.desktopNotifications);
  const setDesktopNotifications = useLayoutStore(
    (layoutState) => layoutState.setDesktopNotifications,
  );

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
        <SettingRow label="Zoom" description="Scale the whole interface.">
          <Select
            ariaLabel="Zoom"
            value={String(zoomPercent)}
            onChange={(next) => setZoomPercent(Number(next))}
            options={zoomOptionsPercent.map((percent) => ({
              value: String(percent),
              label: `${percent}%`,
            }))}
            className={settingsTriggerClass}
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
        <SubsectionHeading>Remote images</SubsectionHeading>
        <SettingRow
          label="Always load remote images"
          description="Load images from every sender, without asking."
        >
          <SettingSwitch
            checked={alwaysLoadRemoteImages}
            onChange={setAlwaysLoadRemoteImages}
            label="Always load remote images"
          />
        </SettingRow>
        <div
          aria-hidden="true"
          className="mb-4.5 mt-1.5 h-px bg-settings-outline-variant opacity-70 dark:bg-dark-settings-outline-variant"
        />
        <TrustedSendersList />
      </div>
      <div
        aria-hidden="true"
        className="h-px bg-settings-outline-variant opacity-70 dark:bg-dark-settings-outline-variant"
      />
      <div className="flex flex-col">
        <SubsectionHeading>Attachments</SubsectionHeading>
        <SettingRow
          label="Prefetch image attachment thumbnails"
          description="Download image attachments as soon as a message opens, so chips show thumbnails."
        >
          <SettingSwitch
            checked={prefetchImageAttachments}
            onChange={setPrefetchImageAttachments}
            label="Prefetch image attachment thumbnails"
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
          <Select
            ariaLabel="Full sync every"
            value={String(secondsToMinutes(syncIntervalSeconds))}
            onChange={(next) => setSyncIntervalSeconds(minutesToSeconds(Number(next)))}
            options={intervalOptionsMinutes.map((minutes) => ({
              value: String(minutes),
              label: `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`,
            }))}
            className={settingsTriggerClass}
          />
        </SettingRow>
      </div>
      <div
        aria-hidden="true"
        className="h-px bg-settings-outline-variant opacity-70 dark:bg-dark-settings-outline-variant"
      />
      <div className="flex flex-col">
        <SubsectionHeading>System</SubsectionHeading>
        {isWindows() && (
          <>
            <SettingRow label="Start at login" description="Open LatentMail when you sign in.">
              <SettingSwitch
                checked={startAtLogin}
                onChange={setStartAtLogin}
                label="Start at login"
              />
            </SettingRow>
            <SettingRow
              label="Close to system tray"
              description="Keep running when the window closes."
            >
              <SettingSwitch
                checked={closeToTray}
                onChange={setCloseToTray}
                label="Close to system tray"
              />
            </SettingRow>
            <SettingRow
              label="Start minimized"
              description={
                closeToTray ? 'Open hidden in the tray.' : 'Requires closing to the tray.'
              }
              disabled={!closeToTray}
            >
              <SettingSwitch
                checked={startMinimized}
                onChange={setStartMinimized}
                label="Start minimized"
                disabled={!closeToTray}
              />
            </SettingRow>
          </>
        )}
        <SettingRow label="Desktop notifications" description="Alert me when new mail arrives.">
          <SettingSwitch
            checked={desktopNotifications}
            onChange={setDesktopNotifications}
            label="Desktop notifications"
          />
        </SettingRow>
      </div>
    </SettingsSection>
  );
}
