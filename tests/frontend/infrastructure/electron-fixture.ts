import fs from 'node:fs';
import path from 'node:path';
import * as os from 'os';


import { expect, test as base, type Page, type TestType, type WorkerInfo } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';

import type { ResetDbOptions, ResetDbResult, TestHookGlobal } from './test-hooks-types';

export type { ResetDbOptions as ResetAppOptions, ResetDbResult as ResetAppResult } from './test-hooks-types';

interface BrowserStorageRoot {
  localStorage: {
    clear(): void;
  };
  sessionStorage: {
    clear(): void;
  };
}

export interface FrontendWorkerFixtures {
  electronApp: ElectronApplication;
  sharedPage: Page;
  resetApp(options?: ResetDbOptions): Promise<ResetDbResult>;
}

export interface FrontendTestFixtures {
  page: Page;
}

const resetAppWaitTimeoutMs = 60_000;

function createWorkerTempDir(workerInfo: WorkerInfo): string {
  const configuredBaseDir = process.env['LATENTMAIL_TEST_TEMP_DIR'];
  if (typeof configuredBaseDir === 'string' && configuredBaseDir.length > 0) {
    fs.mkdirSync(configuredBaseDir, { recursive: true });
    return fs.mkdtempSync(path.join(configuredBaseDir, `worker-${workerInfo.workerIndex}-`));
  }

  return fs.mkdtempSync(path.join(os.tmpdir(), `latentmail-frontend-test-worker-${workerInfo.workerIndex}-`));
}

function cleanupTempDir(tempDirPath: string): void {
  try {
    fs.rmSync(tempDirPath, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 100,
    });
  } catch {
    // Best effort — the launcher-level cleanup will retry at process end.
  }
}

const workerFixtures = {
  electronApp: [
    async (
      {},
      use: (electronApplication: ElectronApplication) => Promise<void>,
      workerInfo: WorkerInfo,
    ) => {
      const workerTempDir = createWorkerTempDir(workerInfo);
      let electronApp: ElectronApplication | null = null;

      try {
        electronApp = await electron.launch({
          args: ['dist-test/tests/frontend/test-frontend-main.js'],
          env: {
            ...process.env,
            LATENTMAIL_TEST_TEMP_DIR: workerTempDir,
          },
        });

      const coverageDir = (process.env.PLAYWRIGHT_COVERAGE_DIR ?? '').trim() || null;
      let coveragePage: Page | undefined;
      let coverageStarted = false;

      function warnCoverageError(phase: string, err: unknown): void {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[electron-fixture] Coverage ${phase} failed: ${msg}`);
      }

      if (coverageDir !== null) {
        try {
          coveragePage = await electronApp.firstWindow();

          if (coveragePage.coverage === undefined) {
            console.warn('Playwright page.coverage is unavailable; skipping frontend coverage collection.');
          } else {
            await coveragePage.coverage.startJSCoverage({ resetOnNavigation: false });
            coverageStarted = true;
          }
        } catch (error) {
          warnCoverageError('start', error);
        }
      }

        await use(electronApp);
      } finally {
        try {
          if (electronApp !== null) {
      
      if (coverageStarted && coveragePage !== undefined && coverageDir !== null) {
        try {
          const entries = await coveragePage.coverage.stopJSCoverage();
          const filteredEntries = entries.filter((entry) => entry.url.startsWith('file://'));
          const coverageFilePath = path.join(
            coverageDir,
            `coverage-${process.pid}-${Date.now()}.json`,
          );

          fs.writeFileSync(
            coverageFilePath,
            JSON.stringify({ result: filteredEntries }),
            'utf8',
          );
        } catch (error) {
          warnCoverageError('stop', error);
        }
      }

      await electronApp.close();
          }
        } finally {
          cleanupTempDir(workerTempDir);
        }
      }
    },
    { scope: 'worker' },
  ],

  sharedPage: [
    async (
      { electronApp }: { electronApp: ElectronApplication },
      use: (sharedPage: Page) => Promise<void>,
    ) => {
      const sharedPage = await electronApp.firstWindow();
      await sharedPage.waitForLoadState('domcontentloaded');
      await use(sharedPage);
    },
    { scope: 'worker' },
  ],

  resetApp: [
    async (
      { electronApp, sharedPage }: { electronApp: ElectronApplication; sharedPage: Page },
      use: (resetApp: (options?: ResetDbOptions) => Promise<ResetDbResult>) => Promise<void>,
    ) => {
      const resetApp = async (options?: ResetDbOptions): Promise<ResetDbResult> => {
        const resetResult = await electronApp.evaluate(
          async (_electronApp, hookOptions: ResetDbOptions | undefined) => {
            const testGlobal = globalThis as TestHookGlobal;
            if (testGlobal.testHooks === undefined) {
              throw new Error('global.testHooks is not available in the Electron main process.');
            }

            return await testGlobal.testHooks.resetDb(hookOptions);
          },
          options,
        ) as ResetDbResult;

        await sharedPage.evaluate(() => {
          const browserGlobal = globalThis as unknown as BrowserStorageRoot;
          browserGlobal.localStorage.clear();
          browserGlobal.sessionStorage.clear();
        });

        // Trigger a reload from the main process and wait for the NEXT load event.
        // We must register the waitForEvent('load') BEFORE triggering the reload
        // so Playwright doesn't miss the event. Promise.all() starts both concurrently,
        // ensuring the listener is registered before webContents.reload() fires.
        //
        // IMPORTANT: Do NOT use waitForLoadState('load') here — it resolves immediately
        // if the page is already in 'load' state, skipping the actual reload wait.
        // waitForEvent('load') waits for the *next* load event, which is what we need.
        await Promise.all([
          sharedPage.waitForEvent('load', { timeout: resetAppWaitTimeoutMs }),
          electronApp.evaluate(async () => {
            const testGlobal = globalThis as import('./test-hooks-types').TestHookGlobal;
            testGlobal.testHooks?.reloadWindow();
          }),
        ]);

        if (options?.seedAccount === false) {
          await expect(sharedPage.getByTestId('auth-login-button')).toBeVisible({ timeout: resetAppWaitTimeoutMs });
        } else {
          await expect(sharedPage.getByTestId('sidebar')).toBeVisible({ timeout: resetAppWaitTimeoutMs });
          await expect(sharedPage.getByTestId('email-list-container')).toBeVisible({ timeout: resetAppWaitTimeoutMs });
        }

        return resetResult;
      };

      await use(resetApp);
    },
    { scope: 'worker' },
  ],
} as const;

// The `page` fixture in Playwright is built-in as test-scoped. We override it here as a
// test-scoped fixture that simply returns the worker-scoped sharedPage reference.
// This lets test files use `{ page }` naturally while all tests share the same Electron window.
const testFixtures = {
  page: async (
    { sharedPage }: { sharedPage: Page },
    use: (page: Page) => Promise<void>,
  ) => {
    await use(sharedPage);
  },
};

// Extend with worker fixtures first, then override the built-in test-scoped `page` with our own.
const testWithWorkerFixtures = base.extend<{}, FrontendWorkerFixtures>(
  workerFixtures as never,
);

export const test = testWithWorkerFixtures.extend<FrontendTestFixtures>(
  testFixtures as never,
) as unknown as TestType<FrontendTestFixtures & { resetApp: (options?: ResetDbOptions) => Promise<ResetDbResult> }, FrontendWorkerFixtures>;

export { expect };
