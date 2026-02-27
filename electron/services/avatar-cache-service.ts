import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import { LoggerService } from './logger-service';

const log = LoggerService.getInstance();

const AVATAR_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 1 day
const IMAGE_FETCH_TIMEOUT_MS = 10000;

export function getAvatarCacheDir(): string {
  return path.join(app.getPath('userData'), 'account-avatars');
}

function getAvatarCacheKey(accountId: number): string {
  return String(accountId);
}

function getExtensionForContentType(contentType: string): string {
  const lower = contentType.toLowerCase();
  if (lower.includes('png')) {
    return '.png';
  }
  if (lower.includes('jpeg') || lower.includes('jpg')) {
    return '.jpg';
  }
  if (lower.includes('webp')) {
    return '.webp';
  }
  return '.jpg';
}

function getContentTypeForExtension(extension: string): string {
  const lower = extension.toLowerCase();
  if (lower === '.png') {
    return 'image/png';
  }
  if (lower === '.webp') {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function findValidCachedAvatarPath(cacheKey: string, now: number): string | null {
  const cacheDir = getAvatarCacheDir();
  if (!fs.existsSync(cacheDir)) {
    return null;
  }
  const extensions = ['.png', '.jpg', '.jpeg', '.webp'];
  for (const extension of extensions) {
    const filePath = path.join(cacheDir, cacheKey + extension);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs < AVATAR_CACHE_TTL_MS) {
        return filePath;
      }
    } catch {
      // file missing or unreadable
    }
  }
  return null;
}

function buildAccountAvatarUrl(filePath: string): string {
  const filename = path.basename(filePath);
  return `account-avatar://${filename}`;
}

async function downloadAvatarToCache(cacheKey: string, remoteUrl: string): Promise<string | null> {
  const cacheDir = getAvatarCacheDir();
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      controller.abort();
    }, IMAGE_FETCH_TIMEOUT_MS);
    const response = await fetch(remoteUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      log.warn(`[AvatarCache] Remote avatar fetch failed with status ${response.status}`);
      return null;
    }

    const contentType = response.headers.get('content-type') ?? '';
    const extension = getExtensionForContentType(contentType);
    const cacheDirPath = getAvatarCacheDir();
    const filePath = path.join(cacheDirPath, cacheKey + extension);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);

    const allExtensions = ['.png', '.jpg', '.jpeg', '.webp'];
    for (const ext of allExtensions) {
      if (ext === extension) {
        continue;
      }
      const otherPath = path.join(cacheDirPath, cacheKey + ext);
      try {
        if (fs.existsSync(otherPath)) {
          fs.unlinkSync(otherPath);
        }
      } catch {
        // ignore
      }
    }

    return filePath;
  } catch (error) {
    log.warn('[AvatarCache] Failed to download avatar:', error);
    return null;
  }
}

export async function getCachedAvatarUrl(accountId: number, remoteUrl: string): Promise<string> {
  if (!remoteUrl || !remoteUrl.trim()) {
    return remoteUrl;
  }

  const cacheKey = getAvatarCacheKey(accountId);
  const now = Date.now();

  const cachedPath = findValidCachedAvatarPath(cacheKey, now);
  if (cachedPath) {
    return buildAccountAvatarUrl(cachedPath);
  }

  const downloadedPath = await downloadAvatarToCache(cacheKey, remoteUrl);
  if (downloadedPath) {
    return buildAccountAvatarUrl(downloadedPath);
  }

  return remoteUrl;
}

export function clearAvatarCacheForAccount(accountId: number): void {
  const cacheKey = getAvatarCacheKey(accountId);
  const cacheDir = getAvatarCacheDir();
  const extensions = ['.png', '.jpg', '.jpeg', '.webp'];
  for (const extension of extensions) {
    const filePath = path.join(cacheDir, cacheKey + extension);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (error) {
      log.warn(`[AvatarCache] Failed to delete cached avatar for account ${accountId}:`, error);
    }
  }
}

export function getContentTypeFromAvatarUrl(urlString: string): string {
  try {
    const parsed = new URL(urlString);
    const filename = parsed.hostname || parsed.pathname.replace(/^\//, '');
    const extension = path.extname(filename);
    if (!extension) {
      return 'image/jpeg';
    }
    return getContentTypeForExtension(extension);
  } catch {
    return 'image/jpeg';
  }
}

