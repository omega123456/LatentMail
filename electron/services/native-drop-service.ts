import { BrowserWindow, app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { LoggerService } from './logger-service';
import { isWindows } from '../utils/platform';
import { IPC_EVENTS } from '../ipc/ipc-channels';

/** Maximum file size in bytes (25MB — matches Gmail limit). */
const MAX_FILE_SIZE = 25 * 1024 * 1024;

/** Maximum number of files per drop. */
const MAX_FILES_PER_DROP = 50;

/** Extension-to-MIME type lookup for common file types. */
const MIME_TYPE_MAP: Record<string, string> = {
  // Images
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',

  // Documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.odt': 'application/vnd.oasis.opendocument.text',
  '.ods': 'application/vnd.oasis.opendocument.spreadsheet',
  '.odp': 'application/vnd.oasis.opendocument.presentation',
  '.rtf': 'application/rtf',

  // Text
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.xml': 'text/xml',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.log': 'text/plain',

  // Archives
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.tar': 'application/x-tar',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',

  // Media
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',

  // Code
  '.js': 'application/javascript',
  '.ts': 'application/typescript',
  '.css': 'text/css',
  '.py': 'text/x-python',
  '.java': 'text/x-java-source',
  '.c': 'text/x-c',
  '.cpp': 'text/x-c++src',
  '.h': 'text/x-c',
  '.hpp': 'text/x-c++hdr',
  '.rs': 'text/x-rust',
  '.go': 'text/x-go',
  '.rb': 'text/x-ruby',

  // Misc
  '.eml': 'message/rfc822',
  '.ics': 'text/calendar',
  '.vcf': 'text/vcard',
};

interface RegisterResult {
  success: boolean;
  hwnd: string;
  error?: string;
  /** True if the drop target was registered on a child HWND (found Chromium's target). */
  registeredOnChild?: boolean;
  /** Number of child HWNDs that had their drop targets revoked. */
  revokedCount?: number;
}

interface NativeAddon {
  registerDropTarget: (
    hwndBuffer: Buffer,
    callbacks: {
      onDragEnter: (meta: { fileCount: number; hasImages: boolean; onlyImages: boolean }) => void;
      onDragOver: () => void;
      onDragLeave: () => void;
      onDrop: (filePaths: string[]) => void;
    }
  ) => RegisterResult;
  unregisterDropTarget: (hwndBuffer: Buffer) => void;
}

interface OsDropImage {
  filename: string;
  mimeType: string;
  dataUrl: string;
}

interface OsDropAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  data: string;
}

/**
 * Singleton service that manages the native Win32 OLE drop target.
 * Windows-only — no-ops on macOS/Linux.
 *
 * Loads the C++ NAPI addon, registers a custom IDropTarget on the BrowserWindow's HWND
 * (replacing Chromium's broken one), and bridges file drop events to the renderer via IPC.
 */
export class NativeDropService {
  private static instance: NativeDropService;
  private readonly log = LoggerService.getInstance();
  private addon: NativeAddon | null = null;
  private hwndBuffer: Buffer | null = null;
  private browserWindow: BrowserWindow | null = null;
  private initialized = false;

  private constructor() {}

  static getInstance(): NativeDropService {
    if (!NativeDropService.instance) {
      NativeDropService.instance = new NativeDropService();
    }
    return NativeDropService.instance;
  }

  /**
   * Initialize the native drop target on the given BrowserWindow.
   * Only operates on Windows — returns immediately on other platforms.
   *
   * Chromium lazily registers its OLE IDropTarget on child HWNDs. We retry
   * with increasing delays to ensure we catch and replace it.
   */
  initialize(browserWindow: BrowserWindow): void {
    if (!isWindows()) {
      return;
    }

    if (this.initialized) {
      this.log.warn('NativeDropService: already initialized');
      return;
    }

    if (browserWindow.isDestroyed() || !browserWindow.webContents) {
      this.log.error('NativeDropService: BrowserWindow is destroyed or has no webContents');
      return;
    }

    this.browserWindow = browserWindow;

    // Load the native addon
    this.addon = this.loadAddon();
    if (!this.addon) {
      return;
    }

    // Get the native window handle
    this.hwndBuffer = browserWindow.getNativeWindowHandle();

    // Register the drop target (WM_DROPFILES approach — only onDrop callback)
    const result = this.addon.registerDropTarget(this.hwndBuffer, {
      onDragEnter: () => {},
      onDragOver: () => {},
      onDragLeave: () => {},
      onDrop: (filePaths: string[]) => {
        this.onDrop(filePaths);
      },
    });

    if (result.success) {
      this.initialized = true;
      this.log.info(
        `NativeDropService: Drop target registered on HWND ${result.hwnd} ` +
        `(onChild=${result.registeredOnChild}, revoked=${result.revokedCount})`
      );
    } else {
      this.log.error(
        `NativeDropService: Failed to register drop target on HWND ${result.hwnd}: ${result.error || 'unknown error'}`
      );
      this.addon = null;
      this.hwndBuffer = null;
    }
  }

  /**
   * Clean up the native drop target. Called on window close.
   */
  cleanup(): void {
    if (!isWindows() || !this.initialized) {
      return;
    }

    try {
      if (this.addon && this.hwndBuffer) {
        this.addon.unregisterDropTarget(this.hwndBuffer);
        this.log.info('NativeDropService: Drop target unregistered');
      }
    } catch (error) {
      this.log.warn('NativeDropService: Error during cleanup:', error);
    }

    this.addon = null;
    this.hwndBuffer = null;
    this.browserWindow = null;
    this.initialized = false;
  }

  /**
   * Load the native addon binary. Tries production path first, then dev fallback.
   */
  private loadAddon(): NativeAddon | null {
    const addonFilename = 'win32_drop_target.node';
    const relativeAddonPath = path.join('native', 'win32-drop-target', 'build', 'Release', addonFilename);

    // Production path: app.asar.unpacked/native/...
    const productionPath = path.join(
      process.resourcesPath || '',
      'app.asar.unpacked',
      relativeAddonPath
    );

    // Development path: relative to dist-electron/services/ → ../../native/...
    const developmentPath = path.join(__dirname, '..', '..', relativeAddonPath);

    const pathsToTry = [productionPath, developmentPath];

    for (const addonPath of pathsToTry) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const loaded = require(addonPath) as NativeAddon;
        if (loaded && typeof loaded.registerDropTarget === 'function') {
          this.log.info(`NativeDropService: Loaded addon from ${addonPath}`);
          return loaded;
        }
      } catch {
        // Path doesn't exist or addon failed to load — try next
      }
    }

    this.log.warn(
      'NativeDropService: Native addon not found — OS file drag-and-drop will not work. ' +
      'Run "yarn build:native" on Windows to build the addon.'
    );
    return null;
  }

  // --- Event handlers (called from COM thread via ThreadSafeFunction) ---

  private onDragEnter(meta: { fileCount: number; hasImages: boolean; onlyImages: boolean }): void {
    if (!this.browserWindow || this.browserWindow.isDestroyed()) {
      return;
    }
    this.browserWindow.webContents.send(IPC_EVENTS.OS_FILE_DRAG_ENTER, {
      fileCount: meta.fileCount,
      hasImages: meta.hasImages,
      onlyImages: meta.onlyImages,
    });
  }

  private onDragLeave(): void {
    if (!this.browserWindow || this.browserWindow.isDestroyed()) {
      return;
    }
    this.browserWindow.webContents.send(IPC_EVENTS.OS_FILE_DRAG_LEAVE, {});
  }

  private onDrop(filePaths: string[]): void {
    if (!this.browserWindow || this.browserWindow.isDestroyed()) {
      return;
    }

    // Process files asynchronously to avoid blocking the event loop
    this.processDroppedFiles(filePaths).then((payload) => {
      if (!this.browserWindow || this.browserWindow.isDestroyed()) {
        return;
      }
      this.browserWindow.webContents.send(IPC_EVENTS.OS_FILE_DROP, payload);
    }).catch((error) => {
      this.log.error('NativeDropService: Error processing dropped files:', error);
      // Send empty payload on error so the renderer clears the overlay
      if (this.browserWindow && !this.browserWindow.isDestroyed()) {
        this.browserWindow.webContents.send(IPC_EVENTS.OS_FILE_DROP, {
          images: [],
          attachments: [],
        });
      }
    });
  }

  /**
   * Process dropped file paths: validate, read, classify, and convert to payload.
   */
  private async processDroppedFiles(
    filePaths: string[]
  ): Promise<{ images: OsDropImage[]; attachments: OsDropAttachment[] }> {
    const images: OsDropImage[] = [];
    const attachments: OsDropAttachment[] = [];

    // Cap at MAX_FILES_PER_DROP
    if (filePaths.length > MAX_FILES_PER_DROP) {
      this.log.warn(
        `NativeDropService: ${filePaths.length} files dropped, processing only first ${MAX_FILES_PER_DROP}`
      );
      filePaths = filePaths.slice(0, MAX_FILES_PER_DROP);
    }

    for (const filePath of filePaths) {
      try {
        // Validate the file path is absolute
        if (!path.isAbsolute(filePath)) {
          this.log.warn(`NativeDropService: Skipping non-absolute path: ${filePath}`);
          continue;
        }

        // Check that the file exists and is a regular file
        const stats = await fs.stat(filePath);
        if (!stats.isFile()) {
          this.log.warn(`NativeDropService: Skipping non-file: ${filePath}`);
          continue;
        }

        // Enforce file size limit
        if (stats.size > MAX_FILE_SIZE) {
          this.log.warn(
            `NativeDropService: Skipping oversized file (${(stats.size / 1024 / 1024).toFixed(1)}MB): ${filePath}`
          );
          continue;
        }

        // Determine MIME type
        const extension = path.extname(filePath).toLowerCase();
        const mimeType = MIME_TYPE_MAP[extension] || 'application/octet-stream';
        if (!MIME_TYPE_MAP[extension]) {
          this.log.warn(`NativeDropService: Unknown extension "${extension}", using application/octet-stream`);
        }

        // Sanitize the filename
        const rawFilename = path.basename(filePath);
        const sanitizedFilename = this.sanitizeFilename(rawFilename);

        // Read the file
        const fileData = await fs.readFile(filePath);
        const base64Data = fileData.toString('base64');

        // Classify: image or attachment
        if (mimeType.startsWith('image/')) {
          images.push({
            filename: sanitizedFilename,
            mimeType,
            dataUrl: `data:${mimeType};base64,${base64Data}`,
          });
        } else {
          attachments.push({
            id: crypto.randomUUID(),
            filename: sanitizedFilename,
            mimeType,
            size: stats.size,
            data: base64Data,
          });
        }
      } catch (error) {
        this.log.warn(`NativeDropService: Failed to read file "${filePath}":`, error);
        // Skip this file and continue with the rest
      }
    }

    if (images.length === 0 && attachments.length === 0 && filePaths.length > 0) {
      this.log.error('NativeDropService: All files in the drop failed to process');
    } else {
      this.log.info(
        `NativeDropService: Processed drop — ${images.length} image(s), ${attachments.length} attachment(s)`
      );
    }

    return { images, attachments };
  }

  /**
   * Sanitize a filename to remove path separators and special characters.
   * Matches the pattern from attachment-ipc.ts.
   */
  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[/\\:*?"<>|]/g, '_')
      .replace(/\0/g, '')
      .trim()
      || 'attachment';
  }
}
