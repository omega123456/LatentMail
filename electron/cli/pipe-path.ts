import * as os from 'os';

/**
 * Compute the platform-appropriate named pipe / Unix socket path for the CLI server.
 *
 * Uses only Node.js built-in modules to stay safe for ELECTRON_RUN_AS_NODE usage.
 * Must NOT import any Electron APIs or app-level services.
 *
 * Pipe path conventions:
 * - Windows: \\.\pipe\LatentMail-<username>-cli (prod) / \\.\pipe\LatentMail-Dev-<username>-cli (dev)
 * - macOS/Linux: /tmp/latentmail-<username>.sock (prod) / /tmp/latentmail-dev-<username>.sock (dev)
 *
 * @param isDev  True in development mode (uses a different path to avoid collisions with prod).
 * @returns The pipe/socket path string.
 */
export function getPipePath(isDev: boolean): string {
  const rawUsername = os.userInfo().username;
  // Sanitize: keep only alphanumeric, underscore, and hyphen characters.
  // Fall back to the numeric UID if the sanitized name is empty (e.g. purely non-ASCII username).
  const sanitized = rawUsername.replace(/[^a-zA-Z0-9_-]/g, '');
  const userInfo = os.userInfo();
  const sanitizedUsername = sanitized || String(userInfo.uid ?? 'unknown');

  if (process.platform === 'win32') {
    const prefix = isDev ? 'LatentMail-Dev' : 'LatentMail';
    return `\\\\.\\pipe\\${prefix}-${sanitizedUsername}-cli`;
  } else {
    const prefix = isDev ? 'latentmail-dev' : 'latentmail';
    return `/tmp/${prefix}-${sanitizedUsername}.sock`;
  }
}
