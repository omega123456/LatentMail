import { afterEach, describe, expect, it, vi } from 'vitest';
import { ipc } from '@/tests/ipc-mock';

type MediaChangeListener = (event: MediaQueryListEvent) => void;

function mockSystemTheme(initialDark = false) {
  let isDark = initialDark;
  let listener: MediaChangeListener | undefined;

  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      get matches() {
        return isDark;
      },
      addEventListener: (_event: string, callback: MediaChangeListener) => {
        listener = callback;
      },
      removeEventListener: vi.fn(),
    })),
  );

  return {
    change(isDarkNext: boolean) {
      isDark = isDarkNext;
      listener?.({ matches: isDarkNext } as MediaQueryListEvent);
    },
  };
}

async function loadThemeStore(isDark = false) {
  const systemTheme = mockSystemTheme(isDark);
  vi.resetModules();
  return { ...(await import('@/stores/theme')), systemTheme };
}

afterEach(() => {
  document.documentElement.classList.remove('dark');
  vi.unstubAllGlobals();
});

describe('theme store', () => {
  it('applies light and dark modes to the document root', async () => {
    const { useThemeStore } = await loadThemeStore();

    useThemeStore.getState().setTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);

    useThemeStore.getState().setTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('uses the operating system setting for system mode', async () => {
    const { useThemeStore } = await loadThemeStore(true);

    expect(useThemeStore.getState().theme).toBe('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('reacts to operating system changes while in system mode', async () => {
    const { systemTheme, useThemeStore } = await loadThemeStore();

    useThemeStore.getState().setTheme('system');
    systemTheme.change(true);
    expect(document.documentElement.classList.contains('dark')).toBe(true);

    systemTheme.change(false);
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('hydrates and persists the selected theme', async () => {
    ipc.override('read_settings', {
      theme: 'dark',
      layout: 'three-column',
      density: 'comfortable',
      sidebarCollapsed: false,
      sidebarWidth: 260,
      listWidth: 350,
      readerHeight: 40,
      syncOnStartup: true,
      showUnreadCounts: true,
      syncIntervalSeconds: 300,
      showSenderAvatars: true,
      zoomPercent: 100,
      alwaysLoadRemoteImages: false,
      allowedImageSenders: [],
      commandOverrides: {},
      logLevel: 'info',
      prefetchImageAttachments: false,
    });
    const { useThemeStore } = await loadThemeStore();
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args);
    });

    await useThemeStore.getState().hydrate();
    useThemeStore.getState().setTheme('light');
    await Promise.resolve();

    expect(useThemeStore.getState()).toMatchObject({ theme: 'light', hydrated: true });
    expect(writes).toEqual([
      {
        key: 'theme',
        value: 'light',
      },
    ]);
  });
});
