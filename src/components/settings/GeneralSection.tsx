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
import { formatCount } from '@/lib/format/strings';
import { SettingsDivider, SettingSwitch, SubsectionHeading } from './primitives';

export { SettingSwitch, SubsectionHeading };

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

function AppearanceDisplayToggles() {
  const layoutState = useLayoutStore();
  return (
    <>
      <SettingRow label="Zoom" description="Scale the whole interface.">
        <Select
          ariaLabel="Zoom"
          value={String(layoutState.zoomPercent)}
          onChange={(next) => layoutState.setZoomPercent(Number(next))}
          options={zoomOptionsPercent.map((percent) => ({
            value: String(percent),
            label: `${percent}%`,
          }))}
          className={settingsTriggerClass}
        />
      </SettingRow>
      <SettingRow label="Show sender avatars" description="Display a picture beside each sender.">
        <SettingSwitch
          checked={layoutState.showSenderAvatars}
          onChange={layoutState.setShowSenderAvatars}
          label="Show sender avatars"
        />
      </SettingRow>
      <SettingRow label="Show unread counts" description="Numbers beside mailboxes in the sidebar.">
        <SettingSwitch
          checked={layoutState.showUnreadCounts}
          onChange={layoutState.setShowUnreadCounts}
          label="Show unread counts"
        />
      </SettingRow>
    </>
  );
}

function AppearanceSubsection() {
  const theme = useThemeStore((themeState) => themeState.theme);
  const setTheme = useThemeStore((themeState) => themeState.setTheme);
  const layout = useLayoutStore((layoutState) => layoutState.layout);
  const setLayout = useLayoutStore((layoutState) => layoutState.setLayout);
  const density = useLayoutStore((layoutState) => layoutState.density);
  const setDensity = useLayoutStore((layoutState) => layoutState.setDensity);
  return (
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
      <AppearanceDisplayToggles />
    </div>
  );
}

function RemoteImagesSubsection() {
  const alwaysLoadRemoteImages = useLayoutStore(
    (layoutState) => layoutState.alwaysLoadRemoteImages,
  );
  const setAlwaysLoadRemoteImages = useLayoutStore(
    (layoutState) => layoutState.setAlwaysLoadRemoteImages,
  );
  return (
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
      <SettingsDivider className="mb-4.5 mt-1.5" />
      <TrustedSendersList />
    </div>
  );
}

function SyncSubsection() {
  const syncOnStartup = useLayoutStore((layoutState) => layoutState.syncOnStartup);
  const setSyncOnStartup = useLayoutStore((layoutState) => layoutState.setSyncOnStartup);
  const syncIntervalSeconds = useLayoutStore((layoutState) => layoutState.syncIntervalSeconds);
  const setSyncIntervalSeconds = useLayoutStore(
    (layoutState) => layoutState.setSyncIntervalSeconds,
  );
  return (
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
            label: formatCount(minutes, 'minute'),
          }))}
          className={settingsTriggerClass}
        />
      </SettingRow>
    </div>
  );
}

function SystemSubsection() {
  const layoutState = useLayoutStore();
  return (
    <div className="flex flex-col">
      <SubsectionHeading>System</SubsectionHeading>
      {isWindows() && (
        <>
          <SettingRow label="Start at login" description="Open LatentMail when you sign in.">
            <SettingSwitch
              checked={layoutState.startAtLogin}
              onChange={layoutState.setStartAtLogin}
              label="Start at login"
            />
          </SettingRow>
          <SettingRow
            label="Close to system tray"
            description="Keep running when the window closes."
          >
            <SettingSwitch
              checked={layoutState.closeToTray}
              onChange={layoutState.setCloseToTray}
              label="Close to system tray"
            />
          </SettingRow>
          <SettingRow
            label="Start minimized"
            description={
              layoutState.closeToTray ? 'Open hidden in the tray.' : 'Requires closing to the tray.'
            }
            disabled={!layoutState.closeToTray}
          >
            <SettingSwitch
              checked={layoutState.startMinimized}
              onChange={layoutState.setStartMinimized}
              label="Start minimized"
              disabled={!layoutState.closeToTray}
            />
          </SettingRow>
        </>
      )}
      <SettingRow label="Desktop notifications" description="Alert me when new mail arrives.">
        <SettingSwitch
          checked={layoutState.desktopNotifications}
          onChange={layoutState.setDesktopNotifications}
          label="Desktop notifications"
        />
      </SettingRow>
    </div>
  );
}

export function GeneralSection() {
  const prefetchImageAttachments = useLayoutStore(
    (layoutState) => layoutState.prefetchImageAttachments,
  );
  const setPrefetchImageAttachments = useLayoutStore(
    (layoutState) => layoutState.setPrefetchImageAttachments,
  );
  return (
    <SettingsSection title="General" description="Changes apply immediately.">
      <AppearanceSubsection />
      <SettingsDivider />
      <RemoteImagesSubsection />
      <SettingsDivider />
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
      <SettingsDivider />
      <SyncSubsection />
      <SettingsDivider />
      <SystemSubsection />
    </SettingsSection>
  );
}
