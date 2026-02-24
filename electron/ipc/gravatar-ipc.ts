import { ipcMain } from 'electron';
import { IPC_CHANNELS, ipcSuccess, ipcError, type IpcResponse } from './ipc-channels';

const GRAVATAR_ORIGIN = 'https://www.gravatar.com';
const GRAVATAR_ORIGIN_ALT = 'https://secure.gravatar.com';
const REQUEST_TIMEOUT_MS = 8000;

/** In-memory cache: URL -> available (true = 200, false = 404 or error). */
const cache = new Map<string, boolean>();

function isAllowedGravatarUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin;
    if (origin !== GRAVATAR_ORIGIN && origin !== GRAVATAR_ORIGIN_ALT) {
      return false;
    }
    if (!parsed.pathname.startsWith('/avatar/')) {
      return false;
    }
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export interface GravatarCheckResult {
  available: boolean;
  url?: string;
}

export function registerGravatarIpcHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.GRAVATAR_CHECK,
    async (_event, url: unknown): Promise<IpcResponse<GravatarCheckResult>> => {
      if (typeof url !== 'string' || !url.trim()) {
        return ipcSuccess({ available: false });
      }
      const trimmed = url.trim();
      if (!isAllowedGravatarUrl(trimmed)) {
        return ipcError('INVALID_URL', 'URL must be a Gravatar avatar URL');
      }

      const cached = cache.get(trimmed);
      if (cached !== undefined) {
        return ipcSuccess({ available: cached, url: cached ? trimmed : undefined });
      }

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        const response = await fetch(trimmed, {
          method: 'HEAD',
          signal: controller.signal,
          redirect: 'follow',
        });
        clearTimeout(timeoutId);
        const available = response.ok;
        cache.set(trimmed, available);
        return ipcSuccess({ available, url: available ? trimmed : undefined });
      } catch {
        cache.set(trimmed, false);
        return ipcSuccess({ available: false });
      }
    }
  );
}
