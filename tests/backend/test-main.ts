/**
 * test-main.ts — Electron test entry point for backend E2E tests.
 *
 * This file replaces production main.ts for test runs. It:
 *   1. Registers custom protocol schemes (MUST be before app.whenReady())
 *   2. Creates a temp directory and sets userData path
 *   3. Delegates shared mock/service bootstrap to tests/shared/test-bootstrap.ts
 *   4. Creates a hidden BrowserWindow with a test preload script
 *   5. Monkey-patches webContents.send to forward events to TestEventBus
 *   6. Runs Mocha and exits with the failure count
 */

import { app, protocol, BrowserWindow } from 'electron';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';

import { TestEventBus } from './infrastructure/test-event-bus';
import { createMochaRunner, runMocha, type MochaRunStats } from './infrastructure/mocha-setup';
import { initializeBootstrap } from '../shared/test-bootstrap';
import type { MessageStore } from './mocks/imap/message-store';
import type { GmailImapServer } from './mocks/imap/gmail-imap-server';
import type { StateInspector } from './mocks/imap/state-inspector';
import type { SmtpCaptureServer } from './mocks/smtp/smtp-capture-server';
import type { FakeOAuthServer } from './mocks/oauth/fake-oauth-server';
import type { FakeOllamaServer } from './mocks/ollama/fake-ollama-server';

let mochaCompleted = false;
let lastMochaStats: MochaRunStats | null = null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'bimi-logo', privileges: { bypassCSP: true, standard: true } },
  { scheme: 'account-avatar', privileges: { bypassCSP: true, standard: true } },
]);

app.disableHardwareAcceleration();

process.on('warning', (warning) => {
  try {
    const electronLog = require('electron-log/main');
    electronLog.warn(`[Node.js process warning] ${warning.name}: ${warning.message}`);
  } catch {
    // electron-log not yet available — warning is intentionally not printed to stdout
  }
});

const STALE_DIR_AGE_MS = 60 * 60 * 1000;
try {
  const tempParentDir = os.tmpdir();
  for (const entry of fs.readdirSync(tempParentDir)) {
    if (entry.startsWith('latentmail-test-')) {
      const fullPath = path.join(tempParentDir, entry);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory() && Date.now() - stat.mtimeMs > STALE_DIR_AGE_MS) {
          fs.rmSync(fullPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          console.log(`[test-main] Cleaned up stale temp dir: ${entry}`);
        }
      } catch {
        // Ignore errors for individual dirs (may be in use by another process)
      }
    }
  }
} catch {
  // Non-fatal: if we can't read tmpdir, just proceed
}

const tempDir = process.env['LATENTMAIL_TEST_TEMP_DIR'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-test-'));
fs.mkdirSync(tempDir, { recursive: true });

app.setPath('userData', tempDir);

const testDbPath = path.join(tempDir, 'latentmail.test.db');

export let ipcHandlerMap: Map<string, (...args: unknown[]) => unknown>;
export let imapStore: MessageStore;
export let imapServer: GmailImapServer;
export let imapStateInspector: StateInspector;
export let smtpServer: SmtpCaptureServer;
export let oauthServer: FakeOAuthServer;
export let ollamaServer: FakeOllamaServer;
export let hiddenWindow: BrowserWindow | null = null;

function forceHiddenWindowInvisible(): void {
  if (hiddenWindow === null || hiddenWindow.isDestroyed()) {
    return;
  }

  try {
    if (hiddenWindow.isFullScreen()) {
      hiddenWindow.setFullScreen(false);
    }
  } catch {
    // Best effort only during test teardown
  }

  try {
    if (hiddenWindow.isMaximized()) {
      hiddenWindow.unmaximize();
    }
  } catch {
    // Best effort only during test teardown
  }

  try {
    if (hiddenWindow.isMinimized()) {
      hiddenWindow.restore();
    }
  } catch {
    // Best effort only during test teardown
  }

  try {
    hiddenWindow.setBounds({ x: -10000, y: -10000, width: 1, height: 1 }, false);
  } catch {
    // Best effort only during test teardown
  }

  try {
    hiddenWindow.setOpacity(0);
  } catch {
    // Best effort only during test teardown
  }

  try {
    hiddenWindow.hide();
  } catch {
    // Best effort only during test teardown
  }
}

async function destroyHiddenWindow(): Promise<void> {
  if (hiddenWindow === null || hiddenWindow.isDestroyed()) {
    hiddenWindow = null;
    return;
  }

  forceHiddenWindowInvisible();

  await new Promise<void>((resolve) => {
    const windowToDestroy = hiddenWindow;
    if (windowToDestroy === null || windowToDestroy.isDestroyed()) {
      hiddenWindow = null;
      resolve();
      return;
    }

    windowToDestroy.once('closed', () => {
      if (hiddenWindow === windowToDestroy) {
        hiddenWindow = null;
      }
      resolve();
    });

    try {
      windowToDestroy.destroy();
    } catch {
      if (hiddenWindow === windowToDestroy) {
        hiddenWindow = null;
      }
      resolve();
    }
  });
}

async function quiesceServicesForShutdown(): Promise<void> {
  try {
    const { SyncQueueBridge } = require('../../electron/services/sync-queue-bridge') as typeof import('../../electron/services/sync-queue-bridge');
    SyncQueueBridge.getInstance().resetForTesting();
  } catch {
    // Best effort only during test shutdown
  }

  try {
    const { BodyFetchQueueService } = require('../../electron/services/body-fetch-queue-service') as typeof import('../../electron/services/body-fetch-queue-service');
    BodyFetchQueueService.getInstance().resetForTesting();
  } catch {
    // Best effort only during test shutdown
  }

  try {
    const { ImapService } = require('../../electron/services/imap-service') as typeof import('../../electron/services/imap-service');
    await ImapService.getInstance().disconnectAllAndClearPending();
  } catch {
    // Best effort only during test shutdown
  }

  try {
    const { ImapCrawlService } = require('../../electron/services/imap-crawl-service') as typeof import('../../electron/services/imap-crawl-service');
    await ImapCrawlService.getInstance().disconnectAll();
  } catch {
    // Best effort only during test shutdown
  }
}

async function stopMockServersForShutdown(): Promise<void> {
  await Promise.allSettled([
    imapServer?.stop(),
    smtpServer?.stop(),
    oauthServer?.stop(),
    ollamaServer?.stop(),
  ]);
}

let shutdownPromise: Promise<void> | null = null;
let preservedExitCode: number | null = null;

function getPreservedExitCode(exitCode: number): number {
  if (preservedExitCode === null) {
    preservedExitCode = exitCode;
  }

  return preservedExitCode;
}

async function waitForShutdownIfRequested(): Promise<boolean> {
  if (shutdownPromise === null) {
    return false;
  }

  await shutdownPromise;
  return true;
}

async function shutdownTestHarness(exitCode: number, trigger: string): Promise<void> {
  const effectiveExitCode = getPreservedExitCode(exitCode);

  if (shutdownPromise !== null) {
    await shutdownPromise;
    return;
  }

  shutdownPromise = (async () => {
    if (trigger.startsWith('signal:')) {
      console.log(`\n[test-main] ${trigger} received, cleaning up...`);
    }

    if (!mochaCompleted && trigger !== 'normal completion') {
      console.error('[test-main] Cleanup started before Mocha reported completion. Treating this as an interrupted test run.');
      if (lastMochaStats !== null) {
        console.error('[test-main] Last known Mocha stats before interruption:', JSON.stringify(lastMochaStats));
      }
    }

    try {
      await destroyHiddenWindow();
    } catch {
      // Best effort
    }

    try {
      await quiesceServicesForShutdown();
    } catch {
      // Best effort
    }

    try {
      await stopMockServersForShutdown();
      console.log('[test-main] Mock servers stopped');
    } catch {
      // Best effort
    }

    if (process.env['NODE_V8_COVERAGE']) {
      try {
        v8.takeCoverage();
      } catch {
        // Best effort
      }
    }

    try {
      fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      console.log('[test-main] Temp directory cleaned up');
    } catch {
      // Best effort — may fail if files are locked
    }

    process.exitCode = effectiveExitCode;
    app.quit();
  })();

  await shutdownPromise;
}

process.on('SIGINT', () => {
  void shutdownTestHarness(130, 'signal:SIGINT');
});

process.on('SIGTERM', () => {
  void shutdownTestHarness(143, 'signal:SIGTERM');
});

app.whenReady().then(async () => {
  console.log('[test-main] Electron app ready. Temp dir:', tempDir);

  try {
    const bootstrap = await initializeBootstrap({
      databasePath: testDbPath,
      tempDir,
    });

    ipcHandlerMap = bootstrap.ipcHandlerMap;
    imapStore = bootstrap.imapStore;
    imapServer = bootstrap.imapServer;
    imapStateInspector = bootstrap.imapStateInspector;
    smtpServer = bootstrap.smtpServer;
    oauthServer = bootstrap.oauthServer;
    ollamaServer = bootstrap.ollamaServer;
  } catch (error) {
    console.error('[test-main] Shared bootstrap initialization failed:', error);
    await shutdownTestHarness(1, 'startup failure');
    return;
  }

  if (await waitForShutdownIfRequested()) {
    return;
  }

  hiddenWindow = new BrowserWindow({
    show: false,
    width: 800,
    height: 600,
    x: -10000,
    y: -10000,
    useContentSize: true,
    fullscreenable: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: false,
    paintWhenInitiallyHidden: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'infrastructure', 'test-preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  hiddenWindow.webContents.send = (channel: string, ...args: unknown[]): void => {
    TestEventBus.getInstance().emit(channel, args);
  };

  hiddenWindow.loadURL('about:blank');

  await new Promise<void>((resolve) => {
    hiddenWindow!.webContents.once('did-finish-load', () => resolve());
  });

  if (await waitForShutdownIfRequested()) {
    return;
  }

  console.log('[test-main] Hidden window ready');

  console.log('[test-main] Starting Mocha test runner...');
  let failures = 0;

  try {
    const mocha = createMochaRunner();
    const mochaRunResult = await runMocha(mocha);
    if (await waitForShutdownIfRequested()) {
      return;
    }
    failures = mochaRunResult.failures;
    mochaCompleted = true;
    lastMochaStats = mochaRunResult.stats;
    console.log('[test-main] Mocha completion summary:', JSON.stringify(mochaRunResult.stats));
  } catch (error) {
    if (await waitForShutdownIfRequested()) {
      return;
    }
    console.error('[test-main] Mocha runner threw an unexpected error:', error);
    failures = 1;
    mochaCompleted = false;
  }

  console.log(`[test-main] Tests complete. Failures: ${failures}`);

  try {
    await destroyHiddenWindow();
    console.log('[test-main] Hidden window destroyed');
  } catch (error) {
    console.warn('[test-main] Failed to destroy hidden window cleanly (non-fatal):', error);
  }

  try {
    await quiesceServicesForShutdown();
  } catch (error) {
    console.warn('[test-main] Failed to quiesce services during shutdown (non-fatal):', error);
  }

  try {
    await stopMockServersForShutdown();
    console.log('[test-main] All mock servers stopped');
  } catch (error) {
    console.warn('[test-main] Error stopping mock servers (non-fatal):', error);
  }

  if (process.env['NODE_V8_COVERAGE']) {
    v8.takeCoverage();
    console.log('[test-main] V8 coverage data flushed');
  }

  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Non-fatal cleanup error
  }

  await shutdownTestHarness(failures, 'normal completion');

  app.exit(failures);
}).catch((error: unknown) => {
  console.error('[test-main] app.whenReady() rejected:', error);
  void shutdownTestHarness(1, 'app.whenReady rejection');
});
