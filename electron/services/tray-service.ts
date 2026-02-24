import { app, Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { IPC_EVENTS } from '../ipc/ipc-channels';

const log = LoggerService.getInstance();

export class TrayService {
  private static instance: TrayService;
  private tray: Tray | null = null;
  private mainWindowRef: BrowserWindow | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private currentUnreadCount = 0;

  private constructor() {}

  static getInstance(): TrayService {
    if (!TrayService.instance) {
      TrayService.instance = new TrayService();
    }
    return TrayService.instance;
  }

  /**
   * Create the system tray icon and attach it to the given main window.
   * Call this once, after `createMainWindow()` in main.ts.
   */
  initialize(mainWindow: BrowserWindow): void {
    this.mainWindowRef = mainWindow;

    try {
      const trayIcon = this.loadTrayIcon();
      this.tray = new Tray(trayIcon);
    } catch (err) {
      log.error('TrayService: failed to create tray:', err);
      return;
    }

    this.tray.setToolTip('Mail Client');
    this.buildContextMenu();

    // Left-click: show and focus main window (standard behavior on Windows/Linux).
    // On macOS, left-click opens the context menu by default, which is correct.
    this.tray.on('click', () => {
      this.showAndFocusMainWindow();
    });

    // Query initial unread count
    this.refreshUnreadCount();

    // Poll every 60 seconds so the badge stays accurate even when the user reads
    // or archives messages from another client.
    this.pollInterval = setInterval(() => {
      this.refreshUnreadCount();
    }, 60_000);

    // Clear the stored reference when the window is destroyed so that
    // resolveMainWindow() falls back to getAllWindows() correctly.
    mainWindow.on('closed', () => {
      this.mainWindowRef = null;
    });

    log.info('TrayService: initialized');
  }

  /**
   * Re-query the database for the total unread Inbox thread count across all
   * accounts and update the tray badge/tooltip.
   *
   * Called on init, on a 60-second poll, and by SyncService after new emails arrive.
   */
  refreshUnreadCount(): void {
    try {
      const dbService = DatabaseService.getInstance();
      const accounts = dbService.getAccounts();
      let totalUnread = 0;
      for (const account of accounts) {
        const counts = dbService.getUnreadThreadCountsByFolder(account.id);
        totalUnread += counts['INBOX'] ?? 0;
      }
      if (totalUnread !== this.currentUnreadCount) {
        this.currentUnreadCount = totalUnread;
        this.updateBadge(totalUnread);
      }
    } catch (err) {
      log.warn('TrayService: failed to refresh unread count:', err);
    }
  }

  /**
   * Destroy the tray icon and stop polling.
   * Call from the app `before-quit` or main window `closed` handler.
   */
  cleanup(): void {
    if (this.pollInterval !== null) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    if (this.tray !== null && !this.tray.isDestroyed()) {
      this.tray.destroy();
      this.tray = null;
    }
    if (process.platform === 'darwin') {
      try {
        app.setBadgeCount(0);
      } catch {
        // Ignore — may fail if app is in process of quitting
      }
    }
    log.info('TrayService: cleaned up');
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Locate a tray icon on disk.  Tries common paths in order:
   *   1. assets/icons/icon.png   (same path used by createMainWindow)
   *   2. assets/icons/icon.ico   (Windows packaged)
   *   3. public/favicon.ico      (dev fallback)
   *   4. dist .../favicon.ico    (production Angular build output)
   *
   * Falls back to an empty native image when none is found — the tray will
   * still be functional, just without a visible icon until real assets are added.
   */
  private loadTrayIcon(): string | Electron.NativeImage {
    const candidatePaths: string[] = [
      path.join(__dirname, '../assets/icons/icon.png'),
      path.join(__dirname, '../assets/icons/icon.ico'),
      path.join(__dirname, '../public/favicon.ico'),
      path.join(__dirname, '../dist/mailclient-app/browser/favicon.ico'),
    ];

    for (const iconPath of candidatePaths) {
      if (fs.existsSync(iconPath)) {
        log.info(`TrayService: using icon at ${iconPath}`);
        return iconPath;
      }
    }

    log.warn('TrayService: no tray icon file found — using empty image. Add assets/icons/icon.png for a proper icon.');
    return nativeImage.createEmpty();
  }

  private updateBadge(count: number): void {
    // macOS: update Dock badge count
    if (process.platform === 'darwin') {
      try {
        app.setBadgeCount(count);
      } catch (err) {
        log.warn('TrayService: failed to set macOS badge count:', err);
      }
    }

    // All platforms: update tray tooltip and rebuild the context menu so the
    // unread count label at the top of the menu stays in sync.
    if (this.tray !== null && !this.tray.isDestroyed()) {
      const tooltip = count > 0
        ? `Mail Client — ${count} unread message${count === 1 ? '' : 's'}`
        : 'Mail Client';
      this.tray.setToolTip(tooltip);
      this.buildContextMenu();
    }
  }

  private buildContextMenu(): void {
    if (this.tray === null || this.tray.isDestroyed()) {
      return;
    }

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

    // Show an unread badge row at the top when there are unread messages
    if (this.currentUnreadCount > 0) {
      const unreadLabel = `${this.currentUnreadCount} unread message${this.currentUnreadCount === 1 ? '' : 's'}`;
      menuTemplate.push({ label: unreadLabel, enabled: false });
      menuTemplate.push({ type: 'separator' });
    }

    menuTemplate.push(
      {
        label: 'Show Mail Client',
        click: () => { this.showAndFocusMainWindow(); },
      },
      {
        label: 'Compose New Email',
        click: () => {
          this.showAndFocusMainWindow();
          this.emitTrayAction('compose');
        },
      },
      {
        label: 'Sync Now',
        click: () => { this.emitTrayAction('sync'); },
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => { app.quit(); },
      },
    );

    const contextMenu = Menu.buildFromTemplate(menuTemplate);
    this.tray.setContextMenu(contextMenu);
  }

  private showAndFocusMainWindow(): void {
    const win = this.resolveMainWindow();
    if (win === null) {
      return;
    }
    if (win.isMinimized()) {
      win.restore();
    }
    win.show();
    win.focus();
  }

  private emitTrayAction(action: string): void {
    const win = this.resolveMainWindow();
    if (win === null || win.isDestroyed()) {
      return;
    }
    win.webContents.send(IPC_EVENTS.SYSTEM_TRAY_ACTION, { action });
  }

  /**
   * Return the tracked main window if alive, or fall back to any open window.
   */
  private resolveMainWindow(): BrowserWindow | null {
    if (this.mainWindowRef !== null && !this.mainWindowRef.isDestroyed()) {
      return this.mainWindowRef;
    }
    const windows = BrowserWindow.getAllWindows();
    return windows.find((win) => !win.isDestroyed()) ?? null;
  }
}
