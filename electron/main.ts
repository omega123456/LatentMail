import { app, BrowserWindow, shell, dialog, Notification, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { LoggerService } from './services/logger-service';
import { registerAllIpcHandlers } from './ipc';
import { getBimiCacheDir } from './ipc/bimi-ipc';
import { DatabaseService } from './services/database-service';
import { OAuthService } from './services/oauth-service';
import { SyncService } from './services/sync-service';
import { SyncQueueBridge } from './services/sync-queue-bridge';
import { ImapService } from './services/imap-service';
import { MailQueueService } from './services/mail-queue-service';
import { NativeDropService } from './services/native-drop-service';
import { TrayService } from './services/tray-service';
import { getAvatarCacheDir } from './services/avatar-cache-service';

// Suppress unused import warning — Notification is used by SyncService via Electron global
void Notification;

// Register custom schemes before app is ready (required for custom protocols to load in renderer)
protocol.registerSchemesAsPrivileged([
  { scheme: 'bimi-logo', privileges: { bypassCSP: true, standard: true } },
  { scheme: 'account-avatar', privileges: { bypassCSP: true, standard: true } },
]);

// Phase 1: Initialize logging with env-based defaults (no DB dependency yet).
const logger = LoggerService.getInstance();

let mainWindow: BrowserWindow | null = null;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) { mainWindow.restore(); }
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    logger.info('LatentMail starting...');

    // Initialize database, then apply the DB-persisted log level (Phase 2).
    try {
      const dbService = DatabaseService.getInstance();
      await dbService.initialize();
      logger.info('Database initialized successfully');

      // Phase 2: Apply the DB-persisted log level (overrides env default if set).
      // Placed inside the try block so it only runs when the DB is fully ready.
      LoggerService.getInstance().initialize();
    } catch (err) {
      logger.error('Failed to initialize database:', err);
    }

    // Register IPC handlers
    registerAllIpcHandlers();

    // Serve cached BIMI logos from disk (bimi-logo://hash.ext)
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
        return new Response(data, {
          headers: { 'Content-Type': contentType },
        });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    });

    // Serve cached account avatars from disk (account-avatar://<filename>)
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
          return new Response(data, {
            headers: { 'Content-Type': contentType },
          });
        } catch {
          return new Response('Not Found', { status: 404 });
        }
      } catch {
        return new Response('Bad Request', { status: 400 });
      }
    });

    // Initialize OAuth token refresh timers for existing accounts
    try {
      const oauthService = OAuthService.getInstance();
      oauthService.initializeRefreshTimers();
    } catch (err) {
      logger.warn('Failed to initialize OAuth refresh timers:', err);
    }

    // Start background sync via SyncQueueBridge.
    // This enqueues per-folder sync items into MailQueueService (concurrency-1 per account),
    // which eliminates the race condition between sync reconciliation and queue operations.
    try {
      SyncQueueBridge.getInstance().start();
    } catch (err) {
      logger.warn('Failed to start SyncQueueBridge:', err);
    }

    // Create the main window
    createMainWindow();

    // Initialize system tray after the main window exists
    if (mainWindow) {
      try {
        TrayService.getInstance().initialize(mainWindow);
      } catch (err) {
        logger.warn('Failed to initialize TrayService:', err);
      }
    }
  });
}

function createMainWindow(): void {
  const isWindows = process.platform === 'win32';

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: !isWindows, // Frameless on Windows for custom titlebar
    titleBarStyle: isWindows ? undefined : 'hiddenInset', // macOS native titlebar with inset
    show: false,
    icon: path.join(__dirname, '../assets/icons/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });

  // Restore window position/size from saved state
  restoreWindowState(mainWindow);

  // Show window when ready; in dev mode open DevTools once the window is shown
  const isDev = process.env['NODE_ENV'] === 'development';
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDev) {
      mainWindow?.webContents.openDevTools();
    }
  });

  // Initialize Win32 native drag-and-drop after page loads (Chromium's render widget
  // child HWND and its IDropTarget only exist after the content has rendered)
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) {
        NativeDropService.getInstance().initialize(mainWindow);
      }
    } catch (err) {
      logger.warn('Failed to initialize NativeDropService:', err);
    }
  });

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Save window state on close; on Windows, hide to tray instead of closing when closeToTray is enabled
  mainWindow.on('close', (event) => {
    if (mainWindow) {
      saveWindowState(mainWindow);
    }
    if (process.platform === 'win32' && !quitting) {
      try {
        const dbService = DatabaseService.getInstance();
        const closeToTrayRaw = dbService.getSetting('closeToTray');
        // Default to true when unset (matches settings store default); only explicit 'false' closes the app
        const closeToTray = closeToTrayRaw === null || closeToTrayRaw === undefined
          ? true
          : closeToTrayRaw === 'true';
        if (closeToTray) {
          event.preventDefault();
          mainWindow?.hide();
        }
      } catch {
        // If reading the setting fails, fall through to default close behavior
      }
    }
  });

  mainWindow.on('closed', () => {
    NativeDropService.getInstance().cleanup();
    mainWindow = null;
  });

  // Load the Angular app (dev: ng serve on 4200; prod: built index)
  if (isDev) {
    mainWindow.loadURL('http://localhost:4200');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/latentmail-app/browser/index.html'));
  }

  logger.info('Main window created');
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    const isMaximized = win.isMaximized();
    const dbService = DatabaseService.getInstance();
    dbService.setSetting('windowState', JSON.stringify({ bounds, isMaximized }));
  } catch (err) {
    logger.warn('Failed to save window state:', err);
  }
}

function restoreWindowState(win: BrowserWindow): void {
  try {
    const dbService = DatabaseService.getInstance();
    const stateStr = dbService.getSetting('windowState');
    if (stateStr) {
      const state = JSON.parse(stateStr);
      if (state.bounds) {
        win.setBounds(state.bounds);
      }
      if (state.isMaximized) {
        win.maximize();
      }
    }
  } catch (err) {
    logger.warn('Failed to restore window state:', err);
  }
}

let quitting = false;

app.on('before-quit', async (event) => {
  // Check for pending queue operations
  if (!quitting) {
    try {
      const queueService = MailQueueService.getInstance();
      const pendingCount = queueService.getPendingCount();

      if (pendingCount > 0 && mainWindow && !mainWindow.isDestroyed()) {
        event.preventDefault();

        const result = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          buttons: ['Close Anyway', 'Wait'],
          defaultId: 1,
          cancelId: 1,
          title: 'Pending Operations',
          message: `There ${pendingCount === 1 ? 'is' : 'are'} ${pendingCount} pending mail operation${pendingCount === 1 ? '' : 's'}.`,
          detail: 'If you close now, these operations will be lost. Would you like to wait for them to complete?',
        });

        if (result.response === 0) {
          // User chose "Close Anyway"
          quitting = true;
          queueService.cancelAllRetries();
          app.quit();
        }
        // else: user chose "Wait" — do nothing, app stays open
        return;
      }
    } catch {
      // Ignore errors during shutdown check
    }
  }

  // Mark as quitting so the window close handler does not intercept the close event
  quitting = true;

  // Stop background sync, IDLE, and disconnect IMAP
  try {
    SyncQueueBridge.getInstance().stop();
    SyncService.getInstance().stopAllIdle().catch(() => {});
    MailQueueService.getInstance().cancelAllRetries();
    ImapService.getInstance().disconnectAll().catch(() => {});
    TrayService.getInstance().cleanup();
  } catch {
    // Ignore cleanup errors
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

export { mainWindow };
