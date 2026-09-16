import { chromium, type FullConfig } from '@playwright/test';
import { installPlaywrightIpc } from './helpers';

export default async function globalSetup(config: FullConfig) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ baseURL: config.projects[0].use.baseURL });
    await installPlaywrightIpc(page);
    await page.goto('/');
    await page.getByTestId('sign-in-screen').waitFor();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector('[data-testid="sign-in-screen"]')!)
          .backgroundColor === 'rgb(250, 248, 255)',
    );
  } finally {
    await browser.close();
  }
}
