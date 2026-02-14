import 'dotenv/config';
import { app, BrowserWindow, shell } from 'electron';
import * as path from 'path';
import log from 'electron-log/main';
import { registerAllIpcHandlers } from './ipc';
import { DatabaseService } from './services/database-service';
import { OAuthService } from './services/oauth-service';
import { SyncService } from './services/sync-service';
import { ImapService } from './services/imap-service';

// Configure logging
log.initialize();
log.transports.file.maxSize = 10 * 1024 * 1024; // 10MB
log.transports.file.level = (process.env['LOG_LEVEL'] as 'debug' | 'info' | 'warn' | 'error') || 'info';

let mainWindow: BrowserWindow | null = null;

// Single instance lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    log.info('MailClient starting...');

    // Initialize database
    try {
      const dbService = DatabaseService.getInstance();
      await dbService.initialize();
      log.info('Database initialized successfully');
    } catch (err) {
      log.error('Failed to initialize database:', err);
    }

    // Register IPC handlers
    registerAllIpcHandlers();

    // Initialize OAuth token refresh timers for existing accounts
    try {
      const oauthService = OAuthService.getInstance();
      oauthService.initializeRefreshTimers();
    } catch (err) {
      log.warn('Failed to initialize OAuth refresh timers:', err);
    }

    // Start background sync for all accounts
    try {
      const syncService = SyncService.getInstance();
      syncService.startBackgroundSync();

      // Trigger initial sync for all accounts
      syncService.syncAllAccounts().catch(err => {
        log.warn('Initial sync failed:', err);
      });
    } catch (err) {
      log.warn('Failed to start background sync:', err);
    }

    // Create the main window
    createMainWindow();
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

  // Open external links in system browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Save window state on close
  mainWindow.on('close', () => {
    if (mainWindow) {
      saveWindowState(mainWindow);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Load the Angular app (dev: ng serve on 4200; prod: built index)
  if (isDev) {
    mainWindow.loadURL('http://localhost:4200');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/mailclient-app/browser/index.html'));
  }

  log.info('Main window created');
}

function saveWindowState(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
    const isMaximized = win.isMaximized();
    const dbService = DatabaseService.getInstance();
    dbService.setSetting('windowState', JSON.stringify({ bounds, isMaximized }));
  } catch (err) {
    log.warn('Failed to save window state:', err);
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
    log.warn('Failed to restore window state:', err);
  }
}

app.on('before-quit', () => {
  // Stop background sync and disconnect IMAP
  try {
    SyncService.getInstance().stopBackgroundSync();
    ImapService.getInstance().disconnectAll().catch(() => {});
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
