import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';
import { useThemeStore } from '@/stores/theme';
import { useSettingsUiStore } from '@/stores/settings-ui';

const account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

function setPlatform(platform: 'macos' | 'windows') {
  Object.assign(window, {
    __TAURI_OS_PLUGIN_INTERNALS__: {
      eol: '\n',
      os_type: platform,
      platform,
      family: platform === 'windows' ? 'windows' : 'unix',
      version: '',
      arch: 'x86_64',
      exe_extension: platform === 'windows' ? 'exe' : '',
    },
  });
}

async function openGeneral() {
  const user = userEvent.setup();
  ipc.override('list_accounts', [account]);
  ipc.override('list_labels', () => []);
  ipc.override('list_threads', () => ({ items: [], nextCursor: null }));
  render(<App />);
  await screen.findByTestId('mail-layout');
  await user.click(screen.getByRole('button', { name: 'Settings' }));
  await screen.findByRole('heading', { name: 'General' });
  return user;
}

async function openGeneralWithDefaults() {
  const user = await openGeneral();
  await act(async () => {
    await useThemeStore.getState().hydrate();
    await useLayoutStore.getState().hydrate();
  });
  act(() => {
    useThemeStore.setState({ theme: 'system' });
    useLayoutStore.setState({
      layout: 'three-column',
      density: 'comfortable',
      showSenderAvatars: true,
      showUnreadCounts: true,
      syncOnStartup: true,
    });
  });
  return user;
}

describe('GeneralSection', () => {
  beforeEach(() => {
    setPlatform('macos');
    act(() => {
      useLayoutStore.setState({
        route: 'mail',
        hydrated: false,
        syncIntervalSeconds: 300,
        zoomPercent: 100,
        alwaysLoadRemoteImages: false,
        allowedImageSenders: [],
      });
      useSettingsUiStore.setState({ activeSection: 'general' });
    });
  });

  it('reflects the persisted settings from read_settings on mount', async () => {
    ipc.override('read_settings', {
      theme: 'dark',
      layout: 'list-only',
      density: 'spacious',
      sidebarCollapsed: false,
      sidebarWidth: 260,
      listWidth: 350,
      readerHeight: 40,
      syncOnStartup: false,
      showUnreadCounts: false,
      syncIntervalSeconds: 120,
      showSenderAvatars: false,
      zoomPercent: 100,
      alwaysLoadRemoteImages: false,
      allowedImageSenders: [],
      commandOverrides: {},
      logLevel: 'info',
      prefetchImageAttachments: false,
    });

    await openGeneral();

    expect(screen.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'List only' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('radio', { name: 'Spacious' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Show sender avatars' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Show unread counts' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('switch', { name: 'Sync when LatentMail starts' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    expect(screen.getByRole('combobox', { name: 'Full sync every' })).toHaveTextContent(
      '2 minutes',
    );
  });

  it('offers 1/2/5/10/15/30 minute options and persists the change in seconds', async () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args as { key: string; value: unknown });
    });
    const user = await openGeneralWithDefaults();

    const select = screen.getByRole('combobox', { name: 'Full sync every' });
    expect(select).toHaveTextContent('5 minutes');

    await user.click(select);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '1 minute',
      '2 minutes',
      '5 minutes',
      '10 minutes',
      '15 minutes',
      '30 minutes',
    ]);
    await user.click(screen.getByRole('option', { name: '10 minutes' }));

    expect(writes).toContainEqual({ key: 'syncIntervalSeconds', value: 600 });
  });

  it('offers zoom levels, applies them to the webview and persists the choice', async () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args as { key: string; value: unknown });
    });
    const user = await openGeneralWithDefaults();

    const select = screen.getByRole('combobox', { name: 'Zoom' });
    expect(select).toHaveTextContent('100%');

    await user.click(select);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      '80%',
      '90%',
      '100%',
      '110%',
      '125%',
      '150%',
    ]);
    await user.click(screen.getByRole('option', { name: '125%' }));

    expect(writes).toContainEqual({ key: 'zoomPercent', value: 125 });
    expect(ipc.tauriSetZoom).toHaveBeenCalledWith(1.25);
  });

  it('writes through write_setting for every control on change', async () => {
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args as { key: string; value: unknown });
    });
    const user = await openGeneralWithDefaults();

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    await user.click(screen.getByRole('radio', { name: 'List only' }));
    await user.click(screen.getByRole('radio', { name: 'Spacious' }));
    await user.click(screen.getByRole('switch', { name: 'Show sender avatars' }));
    await user.click(screen.getByRole('switch', { name: 'Show unread counts' }));
    await user.click(screen.getByRole('switch', { name: 'Sync when LatentMail starts' }));

    expect(writes).toEqual(
      expect.arrayContaining([
        { key: 'theme', value: 'dark' },
        { key: 'layout', value: 'list-only' },
        { key: 'density', value: 'spacious' },
        { key: 'showSenderAvatars', value: false },
        { key: 'showUnreadCounts', value: false },
        { key: 'syncOnStartup', value: false },
      ]),
    );
  });

  it('renders no Save, Apply or Cancel control', async () => {
    await openGeneral();

    expect(screen.queryByRole('button', { name: /^save$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^apply$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
  });

  it('shows all System rows on Windows and disables start minimized without tray closing', async () => {
    setPlatform('windows');
    await openGeneral();
    act(() => {
      useLayoutStore.setState({
        closeToTray: false,
        startMinimized: false,
      });
    });

    expect(screen.getByRole('switch', { name: 'Start at login' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Close to system tray' })).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Start minimized' })).toBeDisabled();
    expect(screen.getByText('Requires closing to the tray.')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Desktop notifications' })).toBeInTheDocument();
  });

  it('shows only desktop notifications in System on macOS', async () => {
    await openGeneral();

    expect(screen.queryByRole('switch', { name: 'Start at login' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Close to system tray' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Start minimized' })).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Desktop notifications' })).toBeInTheDocument();
  });

  it('defaults start minimized to off', async () => {
    setPlatform('windows');
    await openGeneral();

    expect(screen.getByRole('switch', { name: 'Start minimized' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });
});
