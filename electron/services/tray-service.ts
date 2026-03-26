import { app, Tray, Menu, BrowserWindow, nativeImage } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { IPC_EVENTS } from '../ipc/ipc-channels';
import { isMacOS, isWindows } from '../utils/platform';

const log = LoggerService.getInstance();

interface MailNotificationClickPayload {
  accountId: number;
  xGmThrid: string;
  folder: string;
}

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

  /** Whether any account currently needs re-authentication. */
  private needsReauth = false;

  /** Base 32×32 PNG buffer used for compositing badge overlays at runtime. */
  private baseTrayBuffer: Buffer | null = null;

  /** Cached blue dot overlay NativeImage (generated once, reused for all non-zero counts). */
  private dotImage: Electron.NativeImage | null = null;

  /** Cached red dot overlay NativeImage for reauth state (analogous to dotImage). */
  private redDotImage: Electron.NativeImage | null = null;

  /** Cached 16×16 red circle NativeImage used as Windows taskbar overlay icon. */
  private overlayImage: Electron.NativeImage | null = null;

  private pendingMailNotificationClick: MailNotificationClickPayload | null = null;

  private pendingMailNotificationFlushTimer: ReturnType<typeof setTimeout> | null = null;

  private constructor() {}

  static getInstance(): TrayService {
    if (!TrayService.instance) {
      TrayService.instance = new TrayService();
    }
    return TrayService.instance;
  }

  /**
   * Create the system tray icon (Windows/Linux) or set up Dock badge polling
   * (macOS) and attach to the given main window.
   * Call this once, after `createMainWindow()` in main.ts.
   */
  initialize(mainWindow: BrowserWindow): void {
    this.mainWindowRef = mainWindow;
    this.loadBaseTrayBuffer();

    // On macOS, skip tray icon creation — the Dock badge handles status indication.
    // On Windows/Linux, create the system tray icon with click handler and context menu.
    if (!isMacOS()) {
      try {
        const trayIcon = this.loadTrayIconImage('default');
        this.tray = new Tray(trayIcon);
      } catch (err) {
        log.error('TrayService: failed to create tray:', err);
        // Continue without tray — null-checks in downstream methods handle this gracefully
      }

      if (this.tray) {
        this.tray.setToolTip('LatentMail');
        this.buildContextMenu();

        // Left-click: show and focus main window (standard behavior on Windows/Linux).
        this.tray.on('click', () => {
          this.showAndFocusMainWindow();
        });
      }
    }

    // Query initial state (single combined call avoids a double updateBadge)
    this.refreshAllState();

    // Poll every 30 seconds to catch external changes (e.g. read on another device).
    // In-app actions (mark read, move, delete) trigger refreshUnreadCount() immediately.
    this.pollInterval = setInterval(() => {
      this.refreshAllState();
    }, 30_000);

    // Clear the stored reference when the window is destroyed so that
    // resolveMainWindow() falls back to getAllWindows() correctly.
    mainWindow.on('closed', () => {
      this.mainWindowRef = null;
      this.pendingMailNotificationClick = null;
      if (this.pendingMailNotificationFlushTimer !== null) {
        clearTimeout(this.pendingMailNotificationFlushTimer);
        this.pendingMailNotificationFlushTimer = null;
      }
    });

    mainWindow.webContents.on('did-finish-load', () => {
      this.schedulePendingMailNotificationFlush(mainWindow);
    });

    mainWindow.on('show', () => {
      this.schedulePendingMailNotificationFlush(mainWindow);
    });

    log.info('TrayService: initialized');
  }

  /**
   * Re-query the database for the total unread Inbox thread count across all
   * accounts and update the tray badge/tooltip.
   *
   * Called on init, on a 30-second poll, and by SyncService after new emails arrive.
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
   * Re-query the database to check whether any account needs re-authentication,
   * and update the tray badge/overlay/dock immediately.
   */
  refreshReauthState(): void {
    try {
      const dbService = DatabaseService.getInstance();
      const accountList = dbService.getAccounts();
      const anyNeedsReauth = accountList.some((account) => account.needsReauth);

      const previousState = this.needsReauth;
      this.needsReauth = anyNeedsReauth;

      // Invalidate cached red dot images when transitioning away from reauth
      if (previousState && !anyNeedsReauth) {
        this.redDotImage = null;
        this.overlayImage = null;
      }

      // Always call updateBadge to apply changes immediately
      this.updateBadge(this.currentUnreadCount).catch((err) => {
        log.warn('TrayService: failed to update badge after reauth refresh:', err);
      });
    } catch (err) {
      log.warn('TrayService: failed to refresh reauth state:', err);
    }
  }

  /**
   * Combined refresh of both unread count and reauth state, calling
   * `updateBadge()` only once at the end. Used by the poll interval and
   * `initialize()` to avoid a double badge update per cycle.
   *
   * The public `refreshUnreadCount()` and `refreshReauthState()` methods
   * remain available for external callers (SyncService, auth-ipc) that
   * need to update only one dimension immediately.
   */
  private refreshAllState(): void {
    try {
      const dbService = DatabaseService.getInstance();
      const accounts = dbService.getAccounts();

      // Compute unread count across all accounts
      let totalUnread = 0;
      for (const account of accounts) {
        const counts = dbService.getUnreadThreadCountsByFolder(account.id);
        totalUnread += counts['INBOX'] ?? 0;
      }
      this.currentUnreadCount = totalUnread;

      // Compute reauth state
      const anyNeedsReauth = accounts.some((account) => account.needsReauth);
      const previousReauthState = this.needsReauth;
      this.needsReauth = anyNeedsReauth;

      // Invalidate cached red dot images when transitioning away from reauth
      if (previousReauthState && !anyNeedsReauth) {
        this.redDotImage = null;
        this.overlayImage = null;
      }

      // Single badge update covering both state dimensions
      this.updateBadge(this.currentUnreadCount).catch((err) => {
        log.warn('TrayService: failed to update badge:', err);
      });
    } catch (err) {
      log.warn('TrayService: failed to refresh all state:', err);
    }
  }

  /**
   * Destroy the tray icon, stop polling, and clear all platform badge indicators.
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

    // Clear cached badge images
    this.redDotImage = null;
    this.overlayImage = null;

    // Clear Windows taskbar overlay
    if (isWindows() && this.mainWindowRef !== null && !this.mainWindowRef.isDestroyed()) {
      try {
        this.mainWindowRef.setOverlayIcon(null, '');
      } catch {
        // Ignore — may fail if window is in process of being destroyed
      }
    }

    // Clear macOS Dock badge
    if (isMacOS() && app.dock) {
      try {
        app.dock.setBadge('');
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
      if (isMacOS()) {
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
      if (isMacOS()) {
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
   * Composite a badge dot onto the base tray icon.
   *
   * Reauth (red dot, #D32F2F) takes priority over unread (blue dot, #0078D4).
   * Results are cached in `redDotImage` / `dotImage` respectively.
   * Returns the plain base icon when sharp is unavailable or no badge is needed.
   */
  private async loadTrayIconWithBadge(count: number): Promise<Electron.NativeImage> {
    // Reauth red dot takes priority over unread blue dot
    if (this.needsReauth) {
      if (!this.baseTrayBuffer || !sharp) {
        // Graceful degradation: can't composite, fall back to unread icon variant
        return this.loadTrayIconImage('unread');
      }

      if (this.redDotImage !== null) {
        return this.redDotImage;
      }

      try {
        const meta = await sharp!(this.baseTrayBuffer).metadata();
        const size = meta.width ?? 16;

        // Dot: ~25% of icon width, anchored to the top-right corner with 1px inset.
        const radius = Math.max(2, Math.round(size * 0.25));
        const centerX = size - radius - 1;
        const centerY = radius + 1;

        const dotSvg = Buffer.from(
          `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
          `<circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="#D32F2F"/>` +
          `</svg>`,
        );

        const composited = await sharp!(this.baseTrayBuffer)
          .composite([{ input: dotSvg }])
          .png()
          .toBuffer();

        const image = nativeImage.createFromBuffer(composited);

        if (isMacOS()) {
          image.setTemplateImage(false); // dot must stay coloured, not template
        }

        this.redDotImage = image;
        log.info('TrayService: generated reauth red dot icon');
        return image;
      } catch (err) {
        log.warn('TrayService: failed to generate red dot icon:', err);
        return this.loadTrayIconImage('unread');
      }
    }

    // Unread blue dot (existing behavior)
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

    if (isMacOS()) {
      image.setTemplateImage(false); // dot must stay coloured, not template
    }

    this.dotImage = image;
    log.info('TrayService: generated unread dot icon');
    return image;
  }

  /**
   * Generate a 16×16 transparent PNG with a red circle for use as the Windows
   * taskbar overlay icon. Cached in `overlayImage`. Returns null if sharp is
   * unavailable.
   */
  private async generateOverlayImage(): Promise<Electron.NativeImage | null> {
    if (this.overlayImage !== null) {
      return this.overlayImage;
    }

    if (!sharp) {
      return null;
    }

    try {
      const overlaySize = 16;
      const overlayRadius = 6;

      const overlaySvg = Buffer.from(
        `<svg width="${overlaySize}" height="${overlaySize}" xmlns="http://www.w3.org/2000/svg">` +
        `<circle cx="${overlaySize / 2}" cy="${overlaySize / 2}" r="${overlayRadius}" fill="#D32F2F"/>` +
        `</svg>`,
      );

      const overlayBuffer = await sharp!(overlaySvg).png().toBuffer();
      this.overlayImage = nativeImage.createFromBuffer(overlayBuffer);
      log.info('TrayService: generated overlay icon for taskbar');
      return this.overlayImage;
    } catch (err) {
      log.warn('TrayService: failed to generate overlay icon:', err);
      return null;
    }
  }

  private async updateBadge(count: number): Promise<void> {
    // macOS Dock badge: reauth "!" takes priority over numeric unread count
    if (isMacOS() && app.dock) {
      try {
        if (this.needsReauth) {
          app.dock.setBadge('!');
        } else {
          app.dock.setBadge('');
          app.setBadgeCount(count);
        }
      } catch (err) {
        log.warn('TrayService: failed to set macOS badge:', err);
      }
    }

    // Windows taskbar overlay icon: red circle when reauth needed
    if (isWindows()) {
      const overlayWindow = this.resolveMainWindow();
      if (overlayWindow !== null && !overlayWindow.isDestroyed()) {
        try {
          if (this.needsReauth) {
            const overlay = await this.generateOverlayImage();
            if (overlay) {
              overlayWindow.setOverlayIcon(overlay, 'Account needs re-authentication');
            }
          } else {
            overlayWindow.setOverlayIcon(null, '');
          }
        } catch (err) {
          log.warn('TrayService: failed to set overlay icon:', err);
        }
      }
    }

    if (this.tray === null || this.tray.isDestroyed()) {
      return;
    }

    const icon = await this.loadTrayIconWithBadge(count);
    this.tray.setImage(icon);

    // Tooltip: reauth state takes priority over unread-only
    let tooltip: string;
    if (this.needsReauth && count > 0) {
      tooltip = `LatentMail — Account needs re-authentication · ${count} unread`;
    } else if (this.needsReauth) {
      tooltip = 'LatentMail — Account needs re-authentication';
    } else if (count > 0) {
      tooltip = `LatentMail — ${count} unread message${count === 1 ? '' : 's'}`;
    } else {
      tooltip = 'LatentMail';
    }
    this.tray.setToolTip(tooltip);
    this.buildContextMenu();
  }

  private buildContextMenu(): void {
    if (this.tray === null || this.tray.isDestroyed()) {
      return;
    }

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [];

    // Show reauth warning at the top when any account needs re-authentication
    if (this.needsReauth) {
      menuTemplate.push({
        label: '⚠ Account needs re-authentication',
        click: () => { this.showAndFocusMainWindow(); },
      });
      menuTemplate.push({ type: 'separator' });
    }

    // Show an unread badge row when there are unread messages
    if (this.currentUnreadCount > 0) {
      const unreadLabel = `${this.currentUnreadCount} unread message${this.currentUnreadCount === 1 ? '' : 's'}`;
      menuTemplate.push({ label: unreadLabel, enabled: false });
      menuTemplate.push({ type: 'separator' });
    }

    menuTemplate.push(
      {
        label: 'Show LatentMail',
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

  /**
   * Show and focus the main window. Used by tray click and by notification click
   * when the app is in the system tray (window hidden).
   */
  showAndFocusMainWindow(): void {
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

  openMailFromNotification(payload: MailNotificationClickPayload): void {
    const win = this.resolveMainWindow();
    if (win === null || win.isDestroyed()) {
      return;
    }

    const wasVisible = win.isVisible();

    if (win.isMinimized()) {
      win.restore();
    }

    win.show();
    win.focus();

    if (!wasVisible || win.webContents.isLoading()) {
      this.pendingMailNotificationClick = payload;
      this.schedulePendingMailNotificationFlush(win);
      return;
    }

    win.webContents.send(IPC_EVENTS.MAIL_NOTIFICATION_CLICK, payload);
  }

  private schedulePendingMailNotificationFlush(win: BrowserWindow): void {
    if (this.pendingMailNotificationFlushTimer !== null) {
      clearTimeout(this.pendingMailNotificationFlushTimer);
    }

    this.pendingMailNotificationFlushTimer = setTimeout(() => {
      this.pendingMailNotificationFlushTimer = null;
      this.flushPendingMailNotificationClick(win);
    }, 250);
  }

  private flushPendingMailNotificationClick(win: BrowserWindow): void {
    if (this.pendingMailNotificationClick === null || win.isDestroyed()) {
      return;
    }

    if (!win.isVisible() || win.webContents.isLoading()) {
      this.schedulePendingMailNotificationFlush(win);
      return;
    }

    const payload = this.pendingMailNotificationClick;
    this.pendingMailNotificationClick = null;
    win.webContents.send(IPC_EVENTS.MAIL_NOTIFICATION_CLICK, payload);
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
