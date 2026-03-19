import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  getAppliedTheme,
  navigateToSettings,
  returnToMailShell,
  waitForMailShell,
} from '../infrastructure/helpers';

type ThemeMode = 'light' | 'dark' | 'system';

function toThemeLabel(themeMode: ThemeMode): string {
  switch (themeMode) {
    case 'light': {
      return 'Light';
    }
    case 'dark': {
      return 'Dark';
    }
    case 'system': {
      return 'System';
    }
  }
}

async function readThemeMode(page: import('@playwright/test').Page): Promise<ThemeMode> {
  const appliedTheme = await getAppliedTheme(page);

  if (appliedTheme !== 'light' && appliedTheme !== 'dark' && appliedTheme !== 'system') {
    throw new Error(`Unexpected theme value: ${String(appliedTheme)}`);
  }

  return appliedTheme;
}

async function selectTheme(page: import('@playwright/test').Page, themeMode: ThemeMode): Promise<void> {
  await page
    .getByTestId('setting-theme')
    .getByRole('radio', { name: toThemeLabel(themeMode) })
    .click();
}

test.describe('Theme', () => {
  test.describe.configure({ mode: 'serial' });

  let originalTheme: ThemeMode;
  let changedTheme: ThemeMode;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    extractSeededAccount(result);
    await waitForMailShell(page);

    originalTheme = await readThemeMode(page);
    changedTheme = originalTheme === 'dark' ? 'light' : 'dark';
  });

  test('default theme is applied', async ({ page }) => {
    const appliedTheme = await readThemeMode(page);

    expect(['light', 'dark', 'system']).toContain(appliedTheme);
  });

  test('toggling theme in settings changes the DOM', async ({ page }) => {
    await navigateToSettings(page, 'general');
    await expect(page.getByTestId('setting-theme')).toBeVisible();

    if ((await readThemeMode(page)) !== originalTheme) {
      await selectTheme(page, originalTheme);
      await expect.poll(async () => {
        return await readThemeMode(page);
      }).toBe(originalTheme);
    }

    await selectTheme(page, changedTheme);

    await expect.poll(async () => {
      return await readThemeMode(page);
    }).toBe(changedTheme);
  });

  test('theme persists after navigating back to mail', async ({ page }) => {
    await navigateToSettings(page, 'general');
    await expect(page.getByTestId('setting-theme')).toBeVisible();

    if ((await readThemeMode(page)) !== originalTheme) {
      await selectTheme(page, originalTheme);
      await expect.poll(async () => {
        return await readThemeMode(page);
      }).toBe(originalTheme);
    }

    await selectTheme(page, changedTheme);
    await expect.poll(async () => {
      return await readThemeMode(page);
    }).toBe(changedTheme);

    await returnToMailShell(page);
    await waitForMailShell(page);

    await expect.poll(async () => {
      return await readThemeMode(page);
    }).toBe(changedTheme);
  });

  test('toggling back restores original theme', async ({ page }) => {
    await navigateToSettings(page, 'general');
    await expect(page.getByTestId('setting-theme')).toBeVisible();

    await selectTheme(page, originalTheme);

    await expect.poll(async () => {
      return await readThemeMode(page);
    }).toBe(originalTheme);
  });

  test('saved theme from localStorage is restored after a full window reload', async ({ page, electronApp }) => {
    await navigateToSettings(page, 'general');
    await expect(page.getByTestId('setting-theme')).toBeVisible();

    await selectTheme(page, 'dark');
    await expect.poll(async () => {
      return await readThemeMode(page);
    }).toBe('dark');

    await Promise.all([
      page.waitForEvent('load', { timeout: 60_000 }),
      electronApp.evaluate(() => {
        const testGlobal = globalThis as import('../infrastructure/test-hooks-types').TestHookGlobal;
        return testGlobal.testHooks?.reloadWindow() ?? { success: false };
      }),
    ]);

    await waitForMailShell(page);
    await expect.poll(async () => {
      return await readThemeMode(page);
    }).toBe('dark');

    await navigateToSettings(page, 'general');
    await selectTheme(page, originalTheme);
    await expect.poll(async () => {
      return await readThemeMode(page);
    }).toBe(originalTheme);
  });
});
