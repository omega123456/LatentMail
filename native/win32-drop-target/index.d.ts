/** Metadata passed to the onDragEnter callback when files enter the window. */
export interface DragEnterMeta {
  /** Number of files being dragged. */
  fileCount: number;
  /** True if at least one file has an image extension. */
  hasImages: boolean;
  /** True if ALL files are images (no non-image files in the drop). */
  onlyImages: boolean;
}

/** Callback functions passed to registerDropTarget. */
export interface DropTargetCallbacks {
  /** Fired when a file drag enters the window. */
  onDragEnter: (meta: DragEnterMeta) => void;
  /** Fired continuously as the drag moves over the window (no-op recommended). */
  onDragOver: () => void;
  /** Fired when the drag leaves the window. */
  onDragLeave: () => void;
  /** Fired when files are dropped on the window. */
  onDrop: (filePaths: string[]) => void;
}

/** Result from registerDropTarget. */
export interface RegisterResult {
  /** Whether the drop target was successfully registered. */
  success: boolean;
  /** The HWND value that was registered (as a hex string, for logging). */
  hwnd: string;
  /** Error message if registration failed. */
  error?: string;
}

/**
 * Register a custom Win32 OLE IDropTarget on the given window handle,
 * replacing Chromium's broken drop target.
 *
 * @param hwndBuffer - The native window handle buffer from BrowserWindow.getNativeWindowHandle()
 * @param callbacks - Callback functions for drag/drop events
 * @returns Registration result with success status and HWND info
 */
export function registerDropTarget(
  hwndBuffer: Buffer,
  callbacks: DropTargetCallbacks
): RegisterResult;

/**
 * Unregister the custom drop target and clean up COM resources.
 *
 * @param hwndBuffer - The native window handle buffer used during registration
 */
export function unregisterDropTarget(hwndBuffer: Buffer): void;
