/**
 * test-main.ts — Electron test entry point for backend E2E tests.
 *
 * This file replaces production main.ts for test runs. It:
 *   1. Registers custom protocol schemes (MUST be before app.whenReady())
 *   2. Creates a temp directory and sets userData path
 *   3. Starts all mock servers (IMAP, SMTP, OAuth, Ollama) and sets env vars
 *      BEFORE importing any production modules
 *   4. Uses dynamic require() for ALL production service imports (avoids early
 *      singleton initialization at module scope before userData is set)
 *   5. Initializes services in a deterministic order (DB → Logger → VectorDB → Embedding)
 *   6. Skips services not needed for testing (SyncQueueBridge, TrayService, etc.)
 *   7. Wraps ipcMain.handle with a recording shim AFTER activity tracking patch
 *   8. Creates a hidden BrowserWindow with a test preload script
 *   9. Monkey-patches webContents.send to forward events to TestEventBus
 *  10. Runs Mocha and exits with the failure count
 *
 * IMPORTANT: Do NOT add static imports for production modules here.
 * Many services (logger-service, vector-db-service, etc.) call
 * LoggerService.getInstance() at module scope, which would initialize the
 * singleton with the wrong userData path before we can set it.
 */

import { app, protocol, BrowserWindow, ipcMain } from 'electron';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as v8 from 'v8';

// Static imports for test infrastructure only — these do NOT import production services
import { TestEventBus } from './infrastructure/test-event-bus';
import { createMochaRunner, runMocha } from './infrastructure/mocha-setup';
import { GmailImapServer } from './mocks/imap/gmail-imap-server';
import { MessageStore } from './mocks/imap/message-store';
import { StateInspector } from './mocks/imap/state-inspector';
import { SmtpCaptureServer } from './mocks/smtp/smtp-capture-server';
import { FakeOAuthServer } from './mocks/oauth/fake-oauth-server';
import { FakeOllamaServer } from './mocks/ollama/fake-ollama-server';

// ---- Protocol registration (must be BEFORE app.whenReady()) ----
protocol.registerSchemesAsPrivileged([
  { scheme: 'bimi-logo', privileges: { bypassCSP: true, standard: true } },
  { scheme: 'account-avatar', privileges: { bypassCSP: true, standard: true } },
]);

// ---- Disable GPU hardware acceleration (prevents full-screen GPU helper window flash on Windows) ----
app.disableHardwareAcceleration();

// ---- Forward Node.js process warnings to the test log file, not stdout ----
process.on('warning', (warning) => {
  // Lazily access electron-log — it may not be initialized yet at this point.
  // If it fails, we silently ignore (the warning goes nowhere rather than to stdout).
  try {
    const electronLog = require('electron-log/main');
    electronLog.warn(`[Node.js process warning] ${warning.name}: ${warning.message}`);
  } catch {
    // electron-log not yet available — warning is intentionally not printed to stdout
  }
});

// ---- Cleanup stale temp directories from previous interrupted runs ----
// Safety net: delete latentmail-test-* dirs older than 1 hour.
// This handles cases where signal handlers couldn't run (hard kill, crash, etc.)
const STALE_DIR_AGE_MS = 60 * 60 * 1000; // 1 hour
try {
  const tmpParent = os.tmpdir();
  for (const entry of fs.readdirSync(tmpParent)) {
    if (entry.startsWith('latentmail-test-')) {
      const fullPath = path.join(tmpParent, entry);
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

// ---- Create isolated temp directory for this test run ----
const tempDir = process.env['LATENTMAIL_TEST_TEMP_DIR'] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-test-'));
fs.mkdirSync(tempDir, { recursive: true });

// ---- Set userData to our temp dir BEFORE any modules are loaded ----
app.setPath('userData', tempDir);

// ---- Set environment variables BEFORE any production module imports ----
const testDbPath = path.join(tempDir, 'latentmail.test.db');
process.env['DATABASE_PATH'] = testDbPath;
// Speed up queue retries dramatically in tests
process.env['QUEUE_RETRY_BASE_MS'] = '50';
process.env['QUEUE_RETRY_MAX_MS'] = '500';
// Enable OAuth test mode so login() doesn't open a system browser
process.env['OAUTH_TEST_MODE'] = '1';

// ---- IPC handler map (exported for test helpers) ----
// Populated by the ipcMain.handle shim below.
export const ipcHandlerMap = new Map<string, (...args: unknown[]) => unknown>();

// ---- Hidden BrowserWindow (exported for test helpers to get webContents) ----
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

// ---- Mock server singletons (exported for test helpers) ----
export const imapStore = new MessageStore();
export const imapServer = new GmailImapServer(imapStore);
export const imapStateInspector = new StateInspector(imapServer, imapStore);
export const smtpServer = new SmtpCaptureServer();
export const oauthServer = new FakeOAuthServer();
export const ollamaServer = new FakeOllamaServer();

// ---- Signal handlers for graceful cleanup on interrupt (Ctrl+C, SIGTERM) ----
let isCleaningUp = false;

async function cleanupAndExit(exitCode: number): Promise<void> {
  if (isCleaningUp) {
    return;
  }
  isCleaningUp = true;

  console.log('\n[test-main] Signal received, cleaning up...');

  // Destroy hidden window
  try {
    await destroyHiddenWindow();
  } catch {
    // Best effort
  }

  // Stop all mock servers
  try {
    await Promise.allSettled([
      imapServer.stop(),
      smtpServer.stop(),
      oauthServer.stop(),
      ollamaServer.stop(),
    ]);
    console.log('[test-main] Mock servers stopped');
  } catch {
    // Best effort
  }

  // Flush V8 coverage if enabled
  if (process.env['NODE_V8_COVERAGE']) {
    try {
      v8.takeCoverage();
    } catch {
      // Best effort
    }
  }

  // Delete temp directory
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    console.log('[test-main] Temp directory cleaned up');
  } catch {
    // Best effort — may fail if files are locked
  }

  app.exit(exitCode);
}

// Register signal handlers
// SIGINT = Ctrl+C, SIGTERM = kill signal (e.g., from process manager)
process.on('SIGINT', () => {
  cleanupAndExit(130); // 128 + 2 (SIGINT)
});

process.on('SIGTERM', () => {
  cleanupAndExit(143); // 128 + 15 (SIGTERM)
});

// ---- App startup ----
app.whenReady().then(async () => {
  console.log('[test-main] Electron app ready. Temp dir:', tempDir);

  // ---- Step 0: Start all mock servers and configure env vars ----
  // This MUST happen before any production service singletons are created,
  // since singletons capture config at construction time.

  // Start fake IMAP server
  let imapPort: number;
  try {
    imapPort = await imapServer.start();
    process.env['IMAP_HOST'] = '127.0.0.1';
    process.env['IMAP_PORT'] = String(imapPort);
    process.env['IMAP_SECURE'] = 'false';
    console.log(`[test-main] Fake IMAP server started on port ${imapPort}`);
  } catch (error) {
    console.error('[test-main] Failed to start fake IMAP server:', error);
    app.exit(1);
    return;
  }

  // Start fake SMTP server
  let smtpPort: number;
  try {
    smtpPort = await smtpServer.start();
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = String(smtpPort);
    process.env['SMTP_SECURE'] = 'false';
    console.log(`[test-main] Fake SMTP server started on port ${smtpPort}`);
  } catch (error) {
    console.error('[test-main] Failed to start fake SMTP server:', error);
    app.exit(1);
    return;
  }

  // Start fake OAuth HTTPS server
  let oauthPort: number;
  try {
    oauthPort = await oauthServer.start();
    const oauthBaseUrl = oauthServer.getBaseUrl();
    process.env['GOOGLE_TOKEN_URL'] = `${oauthBaseUrl}/o/oauth2/token`;
    process.env['GOOGLE_USERINFO_URL'] = `${oauthBaseUrl}/oauth2/v3/userinfo`;
    process.env['GOOGLE_REVOKE_URL'] = `${oauthBaseUrl}/o/oauth2/revoke`;
    process.env['GOOGLE_AUTH_URL'] = `${oauthBaseUrl}/o/oauth2/v2/auth`;
    console.log(`[test-main] Fake OAuth server started on port ${oauthPort}`);
  } catch (error) {
    console.error('[test-main] Failed to start fake OAuth server:', error);
    app.exit(1);
    return;
  }

  // Start fake Ollama server
  let ollamaPort: number;
  try {
    ollamaPort = await ollamaServer.start();
    process.env['OLLAMA_URL'] = ollamaServer.getBaseUrl();
    console.log(`[test-main] Fake Ollama server started on port ${ollamaPort}`);
  } catch (error) {
    console.error('[test-main] Failed to start fake Ollama server:', error);
    app.exit(1);
    return;
  }

  // Step 1: Initialize DatabaseService
  // Dynamic require AFTER app.setPath() and env vars are set

  // Pre-silence electron-log's console transport BEFORE importing any production modules.
  // Many service modules call LoggerService.getInstance() at module scope (e.g.
  // `const log = LoggerService.getInstance()`), which initializes the singleton and
  // registers a console transport. By disabling it here first, all subsequent log output
  // from production code goes only to the daily log file in temp userData.
  try {
    const electronLog = require('electron-log/main');
    electronLog.transports.console.level = false;
  } catch {
    // Non-fatal — logging may remain noisy but tests still run
  }

  const { DatabaseService } = require('../../electron/services/database-service') as typeof import('../../electron/services/database-service');
  const dbService = DatabaseService.getInstance();

  try {
    await dbService.initialize();
    console.log('[test-main] DatabaseService initialized');
  } catch (error) {
    console.error('[test-main] DatabaseService initialization failed:', error);
    app.exit(1);
    return;
  }

  // Step 2: Re-initialize LoggerService now that DB is ready (applies DB-persisted log level)
  const { LoggerService } = require('../../electron/services/logger-service') as typeof import('../../electron/services/logger-service');
  try {
    LoggerService.getInstance().initialize();
    console.log('[test-main] LoggerService re-initialized');
  } catch (error) {
    console.warn('[test-main] LoggerService re-initialization failed (non-fatal):', error);
  }

  // Ensure the console transport remains silenced even after LoggerService.initialize()
  // overwrites the file transport level (it does not touch the console transport, but
  // belt-and-suspenders to guarantee clean test output).
  try {
    const electronLog = require('electron-log/main');
    electronLog.transports.console.level = false;
  } catch {
    // Non-fatal
  }

  // Step 3: Initialize VectorDbService
  const { VectorDbService } = require('../../electron/services/vector-db-service') as typeof import('../../electron/services/vector-db-service');
  const vectorDbService = VectorDbService.getInstance();
  try {
    vectorDbService.initialize();
    console.log('[test-main] VectorDbService initialized');
  } catch (error) {
    console.warn('[test-main] VectorDbService initialization failed (non-fatal):', error);
  }

  // Step 4: Initialize EmbeddingService (without autoResumeInterruptedBuilds)
  try {
    const { EmbeddingService } = require('../../electron/services/embedding-service') as typeof import('../../electron/services/embedding-service');
    EmbeddingService.getInstance(vectorDbService);
    console.log('[test-main] EmbeddingService initialized');
  } catch (error) {
    console.warn('[test-main] EmbeddingService initialization failed (non-fatal):', error);
  }

  // Step 5: Patch ipcMain for activity tracking (MUST come before the test shim)
  const { patchIpcMainForActivityTracking } = require('../../electron/ipc/ipc-activity-tracker') as typeof import('../../electron/ipc/ipc-activity-tracker');
  patchIpcMainForActivityTracking();
  console.log('[test-main] ipcMain activity tracking patch applied');

  // Step 6: Apply test handler-recording shim on ipcMain.handle
  // At this point ipcMain.handle is the activity-tracked version.
  // We wrap it again to record the original handler in ipcHandlerMap.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activityTrackedHandle = (ipcMain as any).handle.bind(ipcMain) as (
    channel: string,
    listener: (...args: unknown[]) => unknown,
  ) => void;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ipcMain as any).handle = (
    channel: string,
    listener: (...args: unknown[]) => unknown,
  ): void => {
    // Record the raw listener (before activity tracking wrapped it)
    ipcHandlerMap.set(channel, listener);
    // Delegate to the (already activity-tracked) handle
    activityTrackedHandle(channel, listener);
  };

  // Step 7: Register all IPC handlers (now both patches are in place)
  const { registerAllIpcHandlers } = require('../../electron/ipc') as typeof import('../../electron/ipc');
  registerAllIpcHandlers();
  console.log('[test-main] All IPC handlers registered. Total channels:', ipcHandlerMap.size);

  // Step 8: Stop OllamaService health checks immediately (avoids network calls during tests)
  try {
    const { OllamaService } = require('../../electron/services/ollama-service') as typeof import('../../electron/services/ollama-service');
    OllamaService.getInstance().stopHealthChecks();
    console.log('[test-main] OllamaService health checks stopped');
  } catch (error) {
    console.warn('[test-main] Failed to stop OllamaService health checks (non-fatal):', error);
  }

  // Step 9: Register protocol handlers (bimi-logo and account-avatar)
  const { getBimiCacheDir } = require('../../electron/ipc/bimi-ipc') as typeof import('../../electron/ipc/bimi-ipc');
  const { getAvatarCacheDir } = require('../../electron/services/avatar-cache-service') as typeof import('../../electron/services/avatar-cache-service');

  protocol.handle('bimi-logo', (request) => {
    const url = new URL(request.url);
    const filename = url.hostname;
    if (!/^[a-f0-9]{32}\.(svg|png)$/.test(filename)) {
      return new Response('Forbidden', { status: 403 });
    }
    const filePath = path.join(getBimiCacheDir(), filename);
    try {
      const data = fs.readFileSync(filePath);
      const contentType = filename.endsWith('.png') ? 'image/png' : 'image/svg+xml';
      return new Response(data, { headers: { 'Content-Type': contentType } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  protocol.handle('account-avatar', (request) => {
    try {
      const url = new URL(request.url);
      const rawFilename = url.hostname || url.pathname.replace(/^\//, '');
      const filename = rawFilename.trim();
      if (!/^[0-9]+\.(png|jpg|jpeg|webp)$/i.test(filename)) {
        return new Response('Forbidden', { status: 403 });
      }
      const filePath = path.join(getAvatarCacheDir(), filename);
      try {
        const data = fs.readFileSync(filePath);
        const lower = filename.toLowerCase();
        let contentType = 'image/jpeg';
        if (lower.endsWith('.png')) {
          contentType = 'image/png';
        } else if (lower.endsWith('.webp')) {
          contentType = 'image/webp';
        }
        return new Response(data, { headers: { 'Content-Type': contentType } });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });

  // Step 10: Create hidden BrowserWindow for IPC to target
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

  // Step 11: Monkey-patch webContents.send to mirror events to TestEventBus
  // This must happen BEFORE the window loads any content.
  const originalSend = hiddenWindow.webContents.send.bind(hiddenWindow.webContents);
  hiddenWindow.webContents.send = (channel: string, ...args: unknown[]): void => {
    TestEventBus.getInstance().emit(channel, args);
    originalSend(channel, ...args);
  };

  // Load a blank page so the window is ready to receive IPC
  hiddenWindow.loadURL('about:blank');

  // Wait for the window to finish loading before running tests
  await new Promise<void>((resolve) => {
    hiddenWindow!.webContents.once('did-finish-load', () => resolve());
  });

  console.log('[test-main] Hidden window ready');

  // Step 12: Create DB template snapshots after initialization
  // These are used by suite-lifecycle.ts to restore a clean state between suites.
  // We close DBs first so that WAL data is flushed into the main DB file, then
  // copy the .db + (if present) .db-wal + .db-shm sidecar files, then reopen.
  try {
    const templatePath = testDbPath.replace('.test.db', '.test.template.db');

    // Flush WAL to main file by closing before copy
    dbService.close();

    fs.copyFileSync(testDbPath, templatePath);

    const walPath = testDbPath + '-wal';
    const shmPath = testDbPath + '-shm';
    if (fs.existsSync(walPath)) {
      fs.copyFileSync(walPath, templatePath + '-wal');
    }
    if (fs.existsSync(shmPath)) {
      fs.copyFileSync(shmPath, templatePath + '-shm');
    }

    // Reopen the main DB after snapshot
    await dbService.reopen(testDbPath);

    console.log('[test-main] Main DB template snapshot created:', templatePath);

    const vectorDbPath = path.join(tempDir, 'latentmail-vectors.db');
    if (fs.existsSync(vectorDbPath)) {
      const vectorTemplatePath = path.join(tempDir, 'latentmail-vectors.test.template.db');

      vectorDbService.close();

      fs.copyFileSync(vectorDbPath, vectorTemplatePath);

      const vectorWalPath = vectorDbPath + '-wal';
      const vectorShmPath = vectorDbPath + '-shm';
      if (fs.existsSync(vectorWalPath)) {
        fs.copyFileSync(vectorWalPath, vectorTemplatePath + '-wal');
      }
      if (fs.existsSync(vectorShmPath)) {
        fs.copyFileSync(vectorShmPath, vectorTemplatePath + '-shm');
      }

      vectorDbService.reopen(vectorDbPath);

      console.log('[test-main] Vector DB template snapshot created:', vectorTemplatePath);
    }
  } catch (error) {
    console.warn('[test-main] Failed to create DB template snapshots (non-fatal):', error);
  }

  // Step 13: Run Mocha test suites
  console.log('[test-main] Starting Mocha test runner...');
  let failures = 0;

  try {
    const mocha = createMochaRunner();
    failures = await runMocha(mocha);
  } catch (error) {
    console.error('[test-main] Mocha runner threw an unexpected error:', error);
    failures = 1;
  }

  console.log(`[test-main] Tests complete. Failures: ${failures}`);

  // Step 14: Ensure the hidden window cannot become visible during shutdown.
  try {
    await destroyHiddenWindow();
    console.log('[test-main] Hidden window destroyed');
  } catch (error) {
    console.warn('[test-main] Failed to destroy hidden window cleanly (non-fatal):', error);
  }

  // Step 15: Shut down all mock servers
  try {
    await Promise.allSettled([
      imapServer.stop(),
      smtpServer.stop(),
      oauthServer.stop(),
      ollamaServer.stop(),
    ]);
    console.log('[test-main] All mock servers stopped');
  } catch (error) {
    console.warn('[test-main] Error stopping mock servers (non-fatal):', error);
  }

  if (process.env['NODE_V8_COVERAGE']) {
    v8.takeCoverage();
    console.log('[test-main] V8 coverage data flushed');
  }

  // Step 16: Cleanup temp directory
  try {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  } catch {
    // Non-fatal cleanup error
  }

  app.exit(failures);
}).catch((error: unknown) => {
  console.error('[test-main] app.whenReady() rejected:', error);
  app.exit(1);
});
