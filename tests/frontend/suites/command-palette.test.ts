import { test, expect } from '../infrastructure/electron-fixture';
import {
  closeCommandPaletteIfOpen,
  discardComposeIfOpen,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  openCommandPalette,
  waitForMailShell,
} from '../infrastructure/helpers';

async function openCommandPaletteOverlay(
  page: import('@playwright/test').Page,
  shortcutModifier: 'Meta' | 'Control',
): Promise<void> {
  await discardComposeIfOpen(page);
  await closeCommandPaletteIfOpen(page);
  await focusMailShell(page);
  await openCommandPalette(page, shortcutModifier);
  await expect(page.getByTestId('command-palette-input')).toBeFocused();
}

test.describe('Command palette', () => {
  test.describe.configure({ mode: 'serial' });

  let shortcutModifier: 'Meta' | 'Control';

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    extractSeededAccount(result);
    await waitForMailShell(page);
    shortcutModifier = await getShortcutModifier(electronApp);
  });

  test('opens with keyboard shortcut Ctrl+K / Cmd+K', async ({ page }) => {
    await openCommandPaletteOverlay(page, shortcutModifier);
    await closeCommandPaletteIfOpen(page);
  });

  test('shows results when typing', async ({ page }) => {
    await openCommandPaletteOverlay(page, shortcutModifier);

    await page.getByTestId('command-palette-input').fill('compose');

    await expect(page.getByTestId('command-palette-results')).toBeVisible();
    await expect(page.locator('[data-testid^="command-palette-item-"]').first()).toBeVisible();

    await closeCommandPaletteIfOpen(page);
  });

  test('executes command when Enter is pressed', async ({ page }) => {
    await discardComposeIfOpen(page);
    await openCommandPaletteOverlay(page, shortcutModifier);

    await page.getByTestId('command-palette-input').fill('compose new');
    await page.keyboard.press('Enter');

    await expect(page.getByTestId('command-palette')).toBeHidden();
    await expect(page.getByTestId('compose-window')).toBeVisible();

    await discardComposeIfOpen(page);
  });

  test('closes with Escape', async ({ page }) => {
    await openCommandPaletteOverlay(page, shortcutModifier);

    await page.keyboard.press('Escape');

    await expect(page.getByTestId('command-palette')).toBeHidden();
  });
});
