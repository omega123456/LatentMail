import { app, Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { IPC_EVENTS } from '../ipc/ipc-channels';

const log = LoggerService.getInstance();

// sharp is loaded lazily so the app still starts if it hasn't been rebuilt
// for Electron yet. Run `npx @electron/rebuild` to enable badge icons.
let sharp: typeof import('sharp') | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  sharp = require('sharp') as typeof import('sharp');
} catch {
  log.warn('TrayService: sharp not available — badge numbers disabled. Run: npx @electron/rebuild');
}

export class TrayService {
  private static instance: TrayService;
  private tray: Tray | null = null;
  private mainWindowRef: BrowserWindow | null = null;
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private currentUnreadCount = 0;

  /** Base 32×32 PNG buffer used for compositing badge overlays at runtime. */
  private baseTrayBuffer: Buffer | null = null;

  /** Cached dot-overlay NativeImage (generated once, reused for all non-zero counts). */
  private dotImage: Electron.NativeImage | null = null;

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
    this.loadBaseTrayBuffer();

    try {
      const trayIcon = this.loadTrayIconImage('default');
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

    // Poll every 30 seconds to catch external changes (e.g. read on another device).
    // In-app actions (mark read, move, delete) trigger refreshUnreadCount() immediately.
    this.pollInterval = setInterval(() => {
      this.refreshUnreadCount();
    }, 30_000);

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
        this.updateBadge(totalUnread).catch((err) => {
          log.warn('TrayService: failed to update badge:', err);
        });
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
   * Try to load assets/icons/tray-icon.png into memory as the base buffer for
   * badge compositing.  Does nothing if the file doesn't exist (falls back to
   * separate default/unread icons).
   */
  private loadBaseTrayBuffer(): void {
    const trayIconPath = path.join(app.getAppPath(), 'assets', 'icons', 'tray-icon.png');
    if (fs.existsSync(trayIconPath)) {
      this.baseTrayBuffer = fs.readFileSync(trayIconPath);
      log.info('TrayService: loaded base tray buffer for badge mode');
    }
  }

  /**
   * Load a tray icon NativeImage for the given state.
   *
   * When tray-icon.png is present (generated from tray-icon.ico), this is used
   * as the base for all states — the runtime badge overlay takes over for
   * non-zero unread counts.
   *
   * Falls back to separate tray-default / tray-unread PNG pairs, or the main
   * app icon, or an empty NativeImage as a last resort.
   */
  private loadTrayIconImage(type: 'default' | 'unread'): Electron.NativeImage {
    const appPath = app.getAppPath();

    // Badge mode: single tray-icon.png base
    const unifiedPath = path.join(appPath, 'assets', 'icons', 'tray-icon.png');
    if (fs.existsSync(unifiedPath)) {
      const image = nativeImage.createFromPath(unifiedPath);
      if (process.platform === 'darwin') {
        image.setTemplateImage(true);
      }
      return image;
    }

    // Separate icon mode: tray-default.png / tray-unread.png
    const baseName = type === 'unread' ? 'tray-unread' : 'tray-default';
    const path1x = path.join(appPath, 'assets', 'icons', `${baseName}.png`);
    const path2x = path.join(appPath, 'assets', 'icons', `${baseName}@2x.png`);

    if (fs.existsSync(path1x)) {
      const image = nativeImage.createFromPath(path1x);
      if (fs.existsSync(path2x)) {
        const buffer2x = fs.readFileSync(path2x);
        image.addRepresentation({ scaleFactor: 2.0, buffer: buffer2x });
      }
      if (process.platform === 'darwin') {
        image.setTemplateImage(true);
      }
      log.info(`TrayService: using ${baseName} icon`);
      return image;
    }

    // Fallback: main app icon or empty
    const fallbackPaths: string[] = [
      path.join(appPath, 'assets', 'icons', 'icon.png'),
      path.join(appPath, 'assets', 'icons', 'icon.ico'),
      path.join(appPath, 'public', 'favicon.ico'),
      path.join(appPath, 'dist', 'latentmail-app', 'browser', 'favicon.ico'),
    ];
    for (const fallbackPath of fallbackPaths) {
      if (fs.existsSync(fallbackPath)) {
        log.info(`TrayService: falling back to ${fallbackPath}`);
        return nativeImage.createFromPath(fallbackPath);
      }
    }

    log.warn('TrayService: no tray icon found — using empty image. Run yarn build:icons.');
    return nativeImage.createEmpty();
  }

  /**
   * Composite a small blue dot onto the base tray icon to indicate unread mail.
   * The result is generated once and cached in `dotImage`.
   * Returns the plain base icon when sharp is unavailable or count is 0.
   */
  private async loadTrayIconWithBadge(count: number): Promise<Electron.NativeImage> {
    if (count === 0 || !this.baseTrayBuffer || !sharp) {
      return this.loadTrayIconImage(count > 0 ? 'unread' : 'default');
    }

    if (this.dotImage !== null) {
      return this.dotImage;
    }

    // Work at the image's native size to avoid any upscaling blur.
    const meta = await sharp!(this.baseTrayBuffer).metadata();
    const size = meta.width ?? 16;

    // Dot: ~25% of icon width, anchored to the top-right corner with 1px inset.
    const radius = Math.max(2, Math.round(size * 0.25));
    const cx = size - radius - 1;
    const cy = radius + 1;

    const dotSvg = Buffer.from(
      `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      `<circle cx="${cx}" cy="${cy}" r="${radius}" fill="#0078D4"/>` +
      `</svg>`,
    );

    const composited = await sharp!(this.baseTrayBuffer)
      .composite([{ input: dotSvg }])
      .png()
      .toBuffer();

    const image = nativeImage.createFromBuffer(composited);

    if (process.platform === 'darwin') {
      image.setTemplateImage(false); // dot must stay coloured, not template
    }

    this.dotImage = image;
    log.info('TrayService: generated unread dot icon');
    return image;
  }

  private async updateBadge(count: number): Promise<void> {
    // macOS: update Dock badge count
    if (process.platform === 'darwin') {
      try {
        app.setBadgeCount(count);
      } catch (err) {
        log.warn('TrayService: failed to set macOS badge count:', err);
      }
    }

    if (this.tray === null || this.tray.isDestroyed()) {
      return;
    }

    const icon = await this.loadTrayIconWithBadge(count);
    this.tray.setImage(icon);

    const tooltip = count > 0
      ? `Mail Client — ${count} unread message${count === 1 ? '' : 's'}`
      : 'Mail Client';
    this.tray.setToolTip(tooltip);
    this.buildContextMenu();
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
