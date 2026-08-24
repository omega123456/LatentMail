import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import { installPlaywrightIpc } from './helpers';

export default async function globalSetup() {
  execFileSync('node', ['scripts/ensure-playwright-port.mjs'], { stdio: 'inherit' });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await installPlaywrightIpc(page);
  await page.goto('http://127.0.0.1:1420/');
  await page.getByTestId('sign-in-screen').waitFor();
  await page.waitForFunction(
    () =>
      getComputedStyle(document.querySelector('[data-testid="sign-in-screen"]')!)
        .backgroundColor === 'rgb(250, 248, 255)',
  );
  await browser.close();
}
