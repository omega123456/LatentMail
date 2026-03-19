import type { Page } from '@playwright/test';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  navigateToSettings,
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
  returnToMailShell,
  waitForMailShell,
} from '../infrastructure/helpers';

async function readZoomPercentage(page: Page): Promise<number> {
  const indicatorText = await page.getByTestId('zoom-indicator').textContent();
  const match = indicatorText?.match(/(\d+)%/);

  if (match === null || match === undefined) {
    throw new Error(`Unable to parse zoom indicator text: ${String(indicatorText)}`);
  }

  return Number.parseInt(match[1], 10);
}

async function expectZoomIndicator(page: Page): Promise<void> {
  await expect(page.getByTestId('zoom-indicator')).toBeVisible({ timeout: 3000 });
}

test.describe('Zoom', () => {
  test.describe.configure({ mode: 'serial' });

  let shortcutModifier: 'Meta' | 'Control';

  test.beforeAll(async ({ resetApp, electronApp, page }) => {
    const result = await resetApp({ seedAccount: true });
    extractSeededAccount(result);
    await waitForMailShell(page);
    shortcutModifier = await getShortcutModifier(electronApp);
  });

  test('zoom in changes zoom level indicator', async ({ page }) => {
    await focusMailShell(page);
    await page.keyboard.press(`${shortcutModifier}+0`);
    await expectZoomIndicator(page);
    await expect(page.getByTestId('zoom-indicator')).toContainText('100%');

    await page.keyboard.press(`${shortcutModifier}+=`);
    await expectZoomIndicator(page);

    await expect.poll(async () => {
      return await readZoomPercentage(page);
    }).toBeGreaterThan(100);
  });

  test('zoom out decreases zoom level', async ({ page }) => {
    await focusMailShell(page);
    await page.keyboard.press(`${shortcutModifier}+0`);
    await expectZoomIndicator(page);
    await expect(page.getByTestId('zoom-indicator')).toContainText('100%');

    await page.keyboard.press(`${shortcutModifier}+-`);
    await expectZoomIndicator(page);

    await expect.poll(async () => {
      return await readZoomPercentage(page);
    }).toBeLessThan(100);
  });

  test('zoom reset returns to 100%', async ({ page }) => {
    await focusMailShell(page);
    await page.keyboard.press(`${shortcutModifier}+0`);
    await expectZoomIndicator(page);

    await page.keyboard.press(`${shortcutModifier}+=`);
    await expectZoomIndicator(page);
    await expect.poll(async () => {
      return await readZoomPercentage(page);
    }).toBeGreaterThan(100);

    await page.keyboard.press(`${shortcutModifier}+0`);
    await expectZoomIndicator(page);
    await expect(page.getByTestId('zoom-indicator')).toContainText('100%');
  });

  test('repeated zoom in stops at the maximum preset', async ({ page }) => {
    await focusMailShell(page);
    await page.keyboard.press(`${shortcutModifier}+0`);

    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press(`${shortcutModifier}+=`);
    }

    await expectZoomIndicator(page);
    await expect.poll(async () => {
      return await readZoomPercentage(page);
    }).toBe(150);
  });

  test('repeated zoom out stops at the minimum preset', async ({ page }) => {
    await focusMailShell(page);
    await page.keyboard.press(`${shortcutModifier}+0`);

    for (let index = 0; index < 8; index += 1) {
      await page.keyboard.press(`${shortcutModifier}+-`);
    }

    await expectZoomIndicator(page);
    await expect.poll(async () => {
      return await readZoomPercentage(page);
    }).toBe(75);
  });

  test('settings zoom selector reflects non-default zoom and reset hides reset button', async ({ page }) => {
    await focusMailShell(page);
    await page.keyboard.press(`${shortcutModifier}+0`);
    await page.keyboard.press(`${shortcutModifier}+=`);
    await expect.poll(async () => {
      return await readZoomPercentage(page);
    }).toBeGreaterThan(100);

    await navigateToSettings(page, 'general');

    const appearanceSection = page.locator('section').filter({ has: page.locator('h3', { hasText: 'Appearance' }) });
    const zoomSelect = appearanceSection.locator('mat-select');
    await expect(zoomSelect).toContainText('110');

    const resetButton = appearanceSection.locator('button', { hasText: 'Reset to 100%' });
    await expect(resetButton).toBeVisible();
    await resetButton.click();
    await expect(resetButton).not.toBeVisible({ timeout: 5_000 });

    await returnToMailShell(page);
    await waitForMailShell(page);
    await expect(page.getByTestId('zoom-indicator')).toContainText('100%');
  });
});
