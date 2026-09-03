import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 2_000,
  workers: 4,
  retries: 2,
  fullyParallel: true,
  globalSetup: './e2e/global-setup.ts',
  use: {
    ...devices['Desktop Chrome'],
    baseURL: 'http://127.0.0.1:1420',
    viewport: { width: 1280, height: 1024 },
    timezoneId: 'Europe/London',
    deviceScaleFactor: 1.25,
    launchOptions: {
      args: ['--disable-dev-shm-usage', '--disable-gpu', '--disable-background-timer-throttling'],
    },
  },
  webServer: {
    command: 'node ./node_modules/vite/bin/vite.js --host 127.0.0.1',
    url: 'http://127.0.0.1:1420',
    reuseExistingServer: !process.env.CI,
  },
});
