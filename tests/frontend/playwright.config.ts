import * as path from 'path';

import { defineConfig } from '@playwright/test';

const sourceControlledScreenshotsDir = path
  .resolve(__dirname, '../../../tests/frontend/screenshots')
  .replace(/\\/g, '/');

export default defineConfig({
  testDir: path.resolve(__dirname, 'suites'),
  workers: 1,
  retries: 1,
  timeout: 120_000,
  snapshotPathTemplate: `${sourceControlledScreenshotsDir}/{platform}/{testFilePath}/{arg}{ext}`,
  use: {
    trace: 'on-first-retry',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
});
