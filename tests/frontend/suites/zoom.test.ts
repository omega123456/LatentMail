import type { Page } from '@playwright/test';

import { test, expect } from '../infrastructure/electron-fixture';
import {
  extractSeededAccount,
  focusMailShell,
  getShortcutModifier,
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
});
