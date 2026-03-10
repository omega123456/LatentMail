/**
 * test-main.ts — Electron test entry point for backend E2E tests.
 *
 * This file replaces production main.ts for test runs. It:
 *   1. Registers custom protocol schemes (MUST be before app.whenReady())
 *   2. Creates a temp directory and sets userData path
 *   3. Sets all required env vars BEFORE importing any production modules
 *   4. Uses dynamic require() for ALL production service imports (avoids early
 *      singleton initialization at module scope before userData is set)
 *   5. Initializes services in a deterministic order (DB → Logger → VectorDB → Embedding)
 *   6. Skips services not needed for testing (SyncQueueBridge, OAuthService, TrayService, etc.)
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

// Static imports for test infrastructure only — these do NOT import production services
import { TestEventBus } from './infrastructure/test-event-bus';
import { createMochaRunner, runMocha } from './infrastructure/mocha-setup';

// ---- Protocol registration (must be BEFORE app.whenReady()) ----
protocol.registerSchemesAsPrivileged([
  { scheme: 'bimi-logo', privileges: { bypassCSP: true, standard: true } },
  { scheme: 'account-avatar', privileges: { bypassCSP: true, standard: true } },
]);

// ---- Create isolated temp directory for this test run ----
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-test-'));

// ---- Set userData to our temp dir BEFORE any modules are loaded ----
app.setPath('userData', tempDir);

// ---- Set environment variables BEFORE any production module imports ----
const testDbPath = path.join(tempDir, 'latentmail.test.db');
process.env['DATABASE_PATH'] = testDbPath;
process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

// ---- IPC handler map (exported for test helpers) ----
// Populated by the ipcMain.handle shim below.
export const ipcHandlerMap = new Map<string, (...args: unknown[]) => unknown>();

// ---- Hidden BrowserWindow (exported for test helpers to get webContents) ----
export let hiddenWindow: BrowserWindow | null = null;

// ---- App startup ----
app.whenReady().then(async () => {
  console.log('[test-main] Electron app ready. Temp dir:', tempDir);

  // Step 1: Initialize DatabaseService
  // Dynamic require AFTER app.setPath() and env vars are set
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

  // Step 14: Cleanup temp directory
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch {
    // Non-fatal cleanup error
  }

  app.exit(failures);
}).catch((error: unknown) => {
  console.error('[test-main] app.whenReady() rejected:', error);
  app.exit(1);
});
