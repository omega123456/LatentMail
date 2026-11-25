import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export const themes = ['light', 'dark'] as const;

export type ScreenshotTheme = (typeof themes)[number];

export type ScreenshotScenario = {
  name: string;
  run: (page: Page, theme: ScreenshotTheme) => Promise<void>;
};

export const toggleTheme = (page: Page, theme: ScreenshotTheme) =>
  page
    .locator('html')
    .evaluate((element, value) => element.classList.toggle('dark', value === 'dark'), theme);

export async function screenshot(
  page: Page,
  locator: Locator,
  name: string,
  theme: ScreenshotTheme,
) {
  await toggleTheme(page, theme);
  await expect(locator).toHaveScreenshot(`${name}-${theme}.png`);
}
