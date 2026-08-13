import { execFileSync } from 'node:child_process';
import { chromium } from '@playwright/test';

export default async function globalSetup() {
  execFileSync('node', ['scripts/ensure-playwright-port.mjs'], { stdio: 'inherit' });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:1420/');
  await browser.close();
}
