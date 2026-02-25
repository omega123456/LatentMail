import * as crypto from 'crypto';
import { promises as dns } from 'dns';
import * as fs from 'fs';
import * as path from 'path';
import { app, ipcMain } from 'electron';
import psl from 'psl';
import { IPC_CHANNELS, ipcSuccess, type IpcResponse } from './ipc-channels';

const DNS_TIMEOUT_MS = 5000;
const DOH_TIMEOUT_MS = 8000;
const IMAGE_FETCH_TIMEOUT_MS = 10000;
const DISK_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Cloudflare DoH JSON API (used when system DNS fails e.g. ECONNREFUSED). */
const DOH_URL = 'https://cloudflare-dns.com/dns-query';

export interface BimiGetLogoResult {
  logoUrl: string | null;
}

function extractDomain(email: string): string | null {
  const trimmed = (email ?? '').trim().toLowerCase();
  const atIndex = trimmed.indexOf('@');
  if (atIndex === -1) {
    return null;
  }
  const domain = trimmed.slice(atIndex + 1).trim();
  return domain === '' ? null : domain;
}

/** Returns parent domain (one label stripped), or null if that would leave a single label. */
function getParentDomain(domain: string): string | null {
  const labels = domain.split('.').filter(Boolean);
  if (labels.length <= 2) {
    return null;
  }
  return labels.slice(1).join('.');
}

/**
 * Ordered list of domains to try for BIMI: full domain first, then parent, up to the
 * registrable (apex) domain. Uses the Public Suffix List so e.g. aviva.co.uk stops at
 * aviva.co.uk and does not try co.uk.
 */
function domainsToTry(domain: string): string[] {
  const registrable = psl.get(domain);
  if (!registrable || registrable === domain) {
    return [domain];
  }
  const out: string[] = [];
  let current: string | null = domain;
  while (current && current !== registrable) {
    out.push(current);
    current = getParentDomain(current);
  }
  out.push(registrable);
  return out;
}

function parseBimiLogoUrl(txtRecords: string[][]): string | null {
  const joined = txtRecords.flatMap((r) => r).join('');
  const parts = joined.split(';').map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith('l=')) {
      const url = part.slice(2).trim();
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:') {
          return null;
        }
        return url;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('DNS timeout')), ms)
    ),
  ]);
}

/** Resolve TXT via Cloudflare DNS-over-HTTPS. Returns same shape as dns.resolve(hostname, 'TXT'). */
async function resolveTxtViaDoh(hostname: string): Promise<string[][]> {
  const url = `${DOH_URL}?name=${encodeURIComponent(hostname)}&type=TXT`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DOH_TIMEOUT_MS);
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/dns-json' },
    signal: controller.signal,
  });
  clearTimeout(timeoutId);
  if (!response.ok) {
    throw new Error(`DoH HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    Status?: number;
    Answer?: Array<{ type?: number; data?: string }>;
  };
  if (body.Status !== 0) {
    throw new Error(`DoH Status ${body.Status ?? 'unknown'}`);
  }
  const answer = body.Answer ?? [];
  const out: string[][] = [];
  for (const record of answer) {
    if (record.type === 16 && record.data != null) {
      out.push([record.data]);
    }
  }
  return out;
}

export function getBimiCacheDir(): string {
  return path.join(app.getPath('userData'), 'bimi-cache');
}

/** Safe filename: hash of domain (hex, 32 chars). */
function hashDomain(domain: string): string {
  return crypto.createHash('sha256').update(domain).digest('hex').slice(0, 32);
}

/**
 * If we have a valid cached logo for the domain, return its bimi-logo:// URL.
 * Otherwise return null (caller will do DNS + fetch).
 */
function getCachedLogoUrlForDomain(domain: string): string | null {
  const cacheDir = getBimiCacheDir();
  if (!fs.existsSync(cacheDir)) {
    return null;
  }
  const hash = hashDomain(domain);
  const now = Date.now();
  const extensions = ['.svg', '.png'] as const;
  for (const ext of extensions) {
    const filePath = path.join(cacheDir, hash + ext);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs < DISK_CACHE_TTL_MS) {
        return `bimi-logo://${hash}${ext}`;
      }
    } catch {
      // file missing or unreadable
    }
  }
  return null;
}

/**
 * Fetch the logo from remoteUrl and save under the domain key; return bimi-logo:// URL.
 * Caller must have already checked getCachedLogoUrlForDomain (cache hit is handled there).
 */
async function ensureLogoCached(domain: string, remoteUrl: string): Promise<string> {
  const cacheDir = getBimiCacheDir();
  if (!fs.existsSync(cacheDir)) {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  const hash = hashDomain(domain);
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
    const response = await fetch(remoteUrl, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      return remoteUrl;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const ext = contentType.includes('png') ? '.png' : '.svg';
    const filePath = path.join(cacheDir, hash + ext);
    const buffer = Buffer.from(await response.arrayBuffer());
    fs.writeFileSync(filePath, buffer);
    // Remove the other extension if present so we don't leave a stale file.
    const otherExt = ext === '.svg' ? '.png' : '.svg';
    const otherPath = path.join(cacheDir, hash + otherExt);
    try {
      if (fs.existsSync(otherPath)) {
        fs.unlinkSync(otherPath);
      }
    } catch {
      // ignore
    }
    return `bimi-logo://${hash}${ext}`;
  } catch {
    return remoteUrl;
  }
}

export function registerBimiIpcHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.BIMI_GET_LOGO,
    async (_event, email: unknown): Promise<IpcResponse<BimiGetLogoResult>> => {
      if (typeof email !== 'string' || !email.trim()) {
        return ipcSuccess({ logoUrl: null });
      }
      const domain = extractDomain(email);
      if (!domain) {
        return ipcSuccess({ logoUrl: null });
      }

      const toTry = domainsToTry(domain);
      for (const tryDomain of toTry) {
        const cachedLogoUrl = getCachedLogoUrlForDomain(tryDomain);
        if (cachedLogoUrl !== null) {
          return ipcSuccess({ logoUrl: cachedLogoUrl });
        }
        const hostname = `default._bimi.${tryDomain}`;
        let records: string[][];
        try {
          records = await withTimeout(
            dns.resolve(hostname, 'TXT'),
            DNS_TIMEOUT_MS
          );
        } catch {
          try {
            records = await withTimeout(
              resolveTxtViaDoh(hostname),
              DOH_TIMEOUT_MS
            );
          } catch {
            continue;
          }
        }

        const remoteLogoUrl = parseBimiLogoUrl(records);
        if (remoteLogoUrl) {
          const logoUrl = await ensureLogoCached(tryDomain, remoteLogoUrl);
          return ipcSuccess({ logoUrl });
        }
      }
      return ipcSuccess({ logoUrl: null });
    }
  );
}
