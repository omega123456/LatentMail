import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  navigateToSettings,
  returnToMailShell,
  waitForMailShell,
} from '../infrastructure/helpers';

test.describe('Settings', () => {
  test.describe.configure({ mode: 'serial' });

  let accountId: number;

  test.beforeAll(async ({ resetApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    ({ accountId } = extractSeededAccount(result));

    await waitForMailShell(page);
  });

  test('navigates to settings via sidebar link', async ({ page }) => {
    await navigateToSettings(page);
    await expect(page.getByTestId('settings-content')).toBeVisible();
  });

  test('settings nav shows all sections', async ({ page }) => {
    await navigateToSettings(page);

    await expect(page.getByTestId('settings-nav-general')).toBeVisible();
    await expect(page.getByTestId('settings-nav-accounts')).toBeVisible();
    await expect(page.getByTestId('settings-nav-ai')).toBeVisible();
    await expect(page.getByTestId('settings-nav-keyboard')).toBeVisible();
    await expect(page.getByTestId('settings-nav-filters')).toBeVisible();
    await expect(page.getByTestId('settings-nav-queue')).toBeVisible();
    await expect(page.getByTestId('settings-nav-logger')).toBeVisible();
  });

  test('general settings shows theme and density controls', async ({ page }) => {
    await navigateToSettings(page, 'general');

    await expect(page.getByTestId('setting-theme')).toBeVisible();
    await expect(page.getByTestId('setting-density')).toBeVisible();
  });

  test('accounts settings shows the test account card', async ({ page }) => {
    await navigateToSettings(page, 'accounts');

    await expect(page.getByTestId(`account-card-${accountId}`)).toBeVisible();
  });

  test('back to mail link returns to mail shell', async ({ page }) => {
    await returnToMailShell(page);

    await expect(page.getByTestId('settings-nav')).toBeHidden();
  });
});
