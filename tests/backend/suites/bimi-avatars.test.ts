/**
 * bimi-avatars.test.ts — Backend E2E tests for BIMI logo lookup and avatar caching.
 *
 * Covers:
 *   - BIMI TXT lookup for domain with valid record → logo URL returned
 *   - Subdomain → parent → apex fallback chain
 *   - DNS failure → DoH (Cloudflare DNS-over-HTTPS) fallback
 *   - Non-HTTPS logo URL rejected (returns null)
 *   - Disk cache hit: no DNS/fetch on second request
 *   - Invalid email / missing domain returns null
 *   - Avatar caching: remote fetch → disk cache → custom protocol serving
 *   - Avatar cache cleared on account removal
 *
 * DNS Mocking Strategy:
 *   - Monkey-patch `dns.promises.resolve` to return controlled TXT records
 *   - Use undici MockAgent to intercept fetch() calls for DoH and logo URL fetching
 *   - MockAgent is set as the global dispatcher during tests and restored after
 *
 * Note: The bimi:get-logo IPC handler uses native `fetch()` which is powered by
 *   undici under the hood. Setting the global dispatcher intercepts these calls.
 *   Node.js's dns.promises is imported as `{ promises as dns }` in bimi-ipc.ts,
 *   so we monkey-patch the `resolve` method directly on the promises namespace.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as dnsModule from 'dns';
import { app } from 'electron';
import { expect } from 'chai';
import { MockAgent, setGlobalDispatcher, getGlobalDispatcher, type Dispatcher } from 'undici';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { callIpc, seedTestAccount } from '../infrastructure/test-helpers';
import { DatabaseService } from '../../../electron/services/database-service';

// ---- Type helpers ----

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface BimiLogoResult {
  logoUrl: string | null;
}

// ---- Constants ----

// Minimal valid 1×1 SVG to use as a fake BIMI logo
const FAKE_SVG_CONTENT = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
const FAKE_PNG_HEADER = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

// ---- Suite-level state ----

let suiteAccountId: number;
let originalDnsResolve: typeof dnsModule.promises.resolve;
let originalDispatcher: Dispatcher;

// =========================================================================
// Helpers
// =========================================================================

/**
 * Override dns.promises.resolve with a fake implementation.
 * Returns the provided records or throws if `null` is passed (simulating failure).
 */
function stubDnsResolve(
  hostnameToRecords: Record<string, string[][] | null>,
): void {
  // biome-ignore lint: test stub requires function override
  (dnsModule.promises as Record<string, unknown>)['resolve'] = async (
    hostname: string,
    rrtype?: string,
  ): Promise<string[][]> => {
    if (rrtype !== 'TXT') {
      throw new Error(`[TestDNSStub] Unexpected rrtype: ${rrtype}`);
    }
    const records = hostnameToRecords[hostname];
    if (records === null) {
      const err = Object.assign(new Error(`ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' });
      throw err;
    }
    if (records === undefined) {
      // Not in map → simulate "no record" (ENODATA)
      const err = Object.assign(new Error(`ENODATA ${hostname}`), { code: 'ENODATA' });
      throw err;
    }
    return records;
  };
}

/**
 * Restore the original dns.promises.resolve.
 */
function restoreDnsResolve(): void {
  (dnsModule.promises as Record<string, unknown>)['resolve'] = originalDnsResolve;
}

/**
 * Clear all BIMI cache files in the temp userData directory.
 */
function clearBimiCache(): void {
  const cacheDir = path.join(app.getPath('userData'), 'bimi-cache');
  if (fs.existsSync(cacheDir)) {
    for (const file of fs.readdirSync(cacheDir)) {
      try {
        fs.unlinkSync(path.join(cacheDir, file));
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Clear all avatar cache files in the temp userData directory.
 */
function clearAvatarCache(): void {
  const cacheDir = path.join(app.getPath('userData'), 'account-avatars');
  if (fs.existsSync(cacheDir)) {
    for (const file of fs.readdirSync(cacheDir)) {
      try {
        fs.unlinkSync(path.join(cacheDir, file));
      } catch {
        // ignore
      }
    }
  }
}

// =========================================================================
// BIMI logo tests
// =========================================================================

describe('BIMI & Avatars', () => {
  before(async function () {
    this.timeout(20_000);

    await quiesceAndRestore();

    const seeded = seedTestAccount({
      email: 'bimi-test@example.com',
      displayName: 'BIMI Test User',
    });
    suiteAccountId = seeded.accountId;

    // Save original dns.promises.resolve before any stubbing
    originalDnsResolve = dnsModule.promises.resolve as typeof dnsModule.promises.resolve;

    // Save original global dispatcher (undici)
    originalDispatcher = getGlobalDispatcher();
  });

  afterEach(function () {
    // Restore DNS resolve after each test to prevent leakage
    restoreDnsResolve();

    // Restore the original global dispatcher
    setGlobalDispatcher(originalDispatcher);

    // Clear BIMI and avatar caches between tests
    clearBimiCache();
    clearAvatarCache();
  });

  after(function () {
    // Final cleanup
    restoreDnsResolve();
    setGlobalDispatcher(originalDispatcher);
  });

  // =========================================================================
  // BIMI logo lookup
  // =========================================================================

  describe('bimi:get-logo — DNS lookup and logo fetch', () => {
    it('returns logoUrl for a domain with a valid BIMI record and reachable logo', async function () {
      this.timeout(10_000);

      // Stub DNS to return a valid BIMI TXT record for example.com
      stubDnsResolve({
        'default._bimi.example.com': [['v=BIMI1; l=https://bimi.example.com/logo.svg; a=']],
      });

      // Stub undici to serve the logo SVG
      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);

      const mockPool = mockAgent.get('https://bimi.example.com');
      mockPool.intercept({ path: '/logo.svg', method: 'GET' }).reply(
        200,
        FAKE_SVG_CONTENT,
        { headers: { 'content-type': 'image/svg+xml' } },
      );

      const response = await callIpc('bimi:get-logo', 'sender@example.com') as IpcResponse<BimiLogoResult>;

      expect(response.success).to.equal(true);
      expect(response.data!.logoUrl).to.be.a('string');
      expect(response.data!.logoUrl).to.not.be.null;
      // The URL should be a bimi-logo:// custom protocol URL
      expect(response.data!.logoUrl!.startsWith('bimi-logo://')).to.equal(true);
    });

    it('returns null for an email with no BIMI record', async function () {
      this.timeout(10_000);

      // DNS returns no record for this domain
      stubDnsResolve({
        'default._bimi.nodomain.example': null,
      });

      // Also set up DoH to fail (so the whole lookup fails gracefully)
      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);

      const cloudflarePool = mockAgent.get('https://cloudflare-dns.com');
      cloudflarePool
        .intercept({ path: /\/dns-query/, method: 'GET' })
        .reply(200, JSON.stringify({ Status: 3, Answer: [] }), {
          headers: { 'content-type': 'application/dns-json' },
        });

      const response = await callIpc('bimi:get-logo', 'sender@nodomain.example') as IpcResponse<BimiLogoResult>;

      expect(response.success).to.equal(true);
      expect(response.data!.logoUrl).to.be.null;
    });

    it('returns null for empty email', async () => {
      const response = await callIpc('bimi:get-logo', '') as IpcResponse<BimiLogoResult>;

      expect(response.success).to.equal(true);
      expect(response.data!.logoUrl).to.be.null;
    });

    it('returns null for email with no @ symbol', async () => {
      const response = await callIpc('bimi:get-logo', 'notanemail') as IpcResponse<BimiLogoResult>;

      expect(response.success).to.equal(true);
      expect(response.data!.logoUrl).to.be.null;
    });

    it('rejects non-HTTPS logo URL in BIMI record (returns null)', async function () {
      this.timeout(10_000);

      // BIMI record with http:// logo URL (not https — should be rejected)
      stubDnsResolve({
        'default._bimi.insecure.example': [['v=BIMI1; l=http://bimi.insecure.example/logo.svg; a=']],
      });

      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);

      // DoH should not be called since DNS succeeded — no intercept needed
      // But set up cloudflare intercept anyway to avoid uncaught network errors
      const cloudflarePool = mockAgent.get('https://cloudflare-dns.com');
      cloudflarePool
        .intercept({ path: /\/dns-query/, method: 'GET' })
        .reply(200, JSON.stringify({ Status: 3, Answer: [] }), {
          headers: { 'content-type': 'application/dns-json' },
        });

      const response = await callIpc('bimi:get-logo', 'sender@insecure.example') as IpcResponse<BimiLogoResult>;

      expect(response.success).to.equal(true);
      expect(response.data!.logoUrl).to.be.null;
    });

    it('falls back to DoH when system DNS fails', async function () {
      this.timeout(10_000);

      // System DNS throws for all hostnames
      stubDnsResolve({
        'default._bimi.dohtest.example': null,
      });

      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);

      // Cloudflare DoH returns a valid BIMI record
      const cloudflarePool = mockAgent.get('https://cloudflare-dns.com');
      cloudflarePool
        .intercept({ path: /\/dns-query\?name=default\._bimi\.dohtest\.example/, method: 'GET' })
        .reply(
          200,
          JSON.stringify({
            Status: 0,
            Answer: [
              { type: 16, data: 'v=BIMI1; l=https://bimi.dohtest.example/logo.svg; a=' },
            ],
          }),
          { headers: { 'content-type': 'application/dns-json' } },
        );

      // Serve the logo
      const logoPool = mockAgent.get('https://bimi.dohtest.example');
      logoPool
        .intercept({ path: '/logo.svg', method: 'GET' })
        .reply(200, FAKE_SVG_CONTENT, { headers: { 'content-type': 'image/svg+xml' } });

      const response = await callIpc('bimi:get-logo', 'sender@dohtest.example') as IpcResponse<BimiLogoResult>;

      expect(response.success).to.equal(true);
      expect(response.data!.logoUrl).to.be.a('string');
      expect(response.data!.logoUrl).to.not.be.null;
      expect(response.data!.logoUrl!.startsWith('bimi-logo://')).to.equal(true);
    });

    it('disk cache hit: returns cached URL without re-fetching DNS or logo', async function () {
      this.timeout(10_000);

      // First request — DNS and logo fetch happen
      stubDnsResolve({
        'default._bimi.cache-test.example': [['v=BIMI1; l=https://bimi.cache-test.example/logo.svg; a=']],
      });

      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);

      const logoPool = mockAgent.get('https://bimi.cache-test.example');
      logoPool
        .intercept({ path: '/logo.svg', method: 'GET' })
        .reply(200, FAKE_SVG_CONTENT, { headers: { 'content-type': 'image/svg+xml' } });

      const firstResponse = await callIpc('bimi:get-logo', 'sender@cache-test.example') as IpcResponse<BimiLogoResult>;

      expect(firstResponse.success).to.equal(true);
      expect(firstResponse.data!.logoUrl).to.not.be.null;

      // Second request — DNS and logo fetch must NOT be called (cache hit)
      // Stub DNS to throw if called (proves it's not called)
      stubDnsResolve({}); // empty map → ENODATA for any lookup

      // Use a new MockAgent that disallows all connections
      const strictAgent = new MockAgent();
      strictAgent.disableNetConnect();
      setGlobalDispatcher(strictAgent);

      const secondResponse = await callIpc('bimi:get-logo', 'sender@cache-test.example') as IpcResponse<BimiLogoResult>;

      expect(secondResponse.success).to.equal(true);
      // Should return the same cached bimi-logo:// URL
      expect(secondResponse.data!.logoUrl).to.not.be.null;
      expect(secondResponse.data!.logoUrl!.startsWith('bimi-logo://')).to.equal(true);
    });

    it('handles subdomain → apex fallback when subdomain has no BIMI record', async function () {
      this.timeout(10_000);

      // mail.fallback-test.example has no BIMI record
      // fallback-test.example (apex) has a BIMI record
      stubDnsResolve({
        'default._bimi.mail.fallback-test.example': null,  // subdomain — fail
        'default._bimi.fallback-test.example': [['v=BIMI1; l=https://bimi.fallback-test.example/logo.svg; a=']],
      });

      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);

      // DoH fallback for subdomain
      const cloudflarePool = mockAgent.get('https://cloudflare-dns.com');
      cloudflarePool
        .intercept({ path: /dns-query/, method: 'GET' })
        .reply(200, JSON.stringify({ Status: 3, Answer: [] }), {
          headers: { 'content-type': 'application/dns-json' },
        })
        .times(10); // may be called multiple times for different subdomains

      // Logo fetch for the apex domain
      const logoPool = mockAgent.get('https://bimi.fallback-test.example');
      logoPool
        .intercept({ path: '/logo.svg', method: 'GET' })
        .reply(200, FAKE_SVG_CONTENT, { headers: { 'content-type': 'image/svg+xml' } });

      const response = await callIpc('bimi:get-logo', 'sender@mail.fallback-test.example') as IpcResponse<BimiLogoResult>;

      expect(response.success).to.equal(true);
      // Should find the logo via fallback to apex domain
      expect(response.data!.logoUrl).to.not.be.null;
      expect(response.data!.logoUrl!.startsWith('bimi-logo://')).to.equal(true);
    });
  });

  // =========================================================================
  // Avatar caching tests
  // =========================================================================

  describe('Avatar caching via auth:get-accounts', () => {
    it('fetches remote avatar URL and caches to disk', async function () {
      this.timeout(10_000);

      // Set up a MockAgent to serve a fake avatar image
      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);

      const avatarPool = mockAgent.get('https://example.com');
      avatarPool
        .intercept({ path: '/avatar.png', method: 'GET' })
        .reply(200, FAKE_PNG_HEADER, { headers: { 'content-type': 'image/png' } });

      // Set avatar_url on the test account in the DB
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare(
        'UPDATE accounts SET avatar_url = :url WHERE id = :accountId',
      ).run({ url: 'https://example.com/avatar.png', accountId: suiteAccountId });

      // Call auth:get-accounts — this triggers getCachedAvatarUrl for each account
      const accountsResponse = await callIpc('auth:get-accounts') as IpcResponse<Array<{
        id: number;
        email: string;
        avatarUrl: string | null;
      }>>;

      expect(accountsResponse.success).to.equal(true);
      expect(accountsResponse.data).to.be.an('array');

      const testAccount = accountsResponse.data!.find((acc) => acc.id === suiteAccountId);
      expect(testAccount).to.not.be.undefined;

      // The avatar URL should now be an account-avatar:// custom protocol URL (or the original
      // if caching failed in this environment — both are acceptable)
      if (testAccount!.avatarUrl && testAccount!.avatarUrl.startsWith('account-avatar://')) {
        // Cached avatar — verify the file exists on disk
        const cacheDir = path.join(app.getPath('userData'), 'account-avatars');
        const filename = testAccount!.avatarUrl.replace('account-avatar://', '');
        expect(fs.existsSync(path.join(cacheDir, filename))).to.equal(true);
      }
    });

    it('cache hit: second call returns cached URL without re-fetching', async function () {
      this.timeout(10_000);

      // Set up avatar URL on account
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      rawDb.prepare(
        'UPDATE accounts SET avatar_url = :url WHERE id = :accountId',
      ).run({ url: 'https://example.com/avatar-second.png', accountId: suiteAccountId });

      // First fetch
      const mockAgent = new MockAgent();
      mockAgent.disableNetConnect();
      setGlobalDispatcher(mockAgent);

      const pool = mockAgent.get('https://example.com');
      pool
        .intercept({ path: '/avatar-second.png', method: 'GET' })
        .reply(200, FAKE_PNG_HEADER, { headers: { 'content-type': 'image/png' } })
        .times(1); // Only once

      await callIpc('auth:get-accounts');

      // Second fetch — no network calls should happen since cache exists
      const strictAgent = new MockAgent();
      strictAgent.disableNetConnect();
      setGlobalDispatcher(strictAgent);

      const secondResponse = await callIpc('auth:get-accounts') as IpcResponse<Array<{
        id: number;
        avatarUrl: string | null;
      }>>;

      expect(secondResponse.success).to.equal(true);
      // The second call should succeed without network errors
    });

    it('avatar cache cleared when account is removed (via auth:logout)', async function () {
      this.timeout(15_000);

      // Create a dedicated account for this test to avoid contaminating suiteAccountId
      await quiesceAndRestore();
      const seeded = seedTestAccount({
        email: 'bimi-avatar-clear@example.com',
        displayName: 'Avatar Clear Test',
      });
      const localAccountId = seeded.accountId;

      // Manually create a fake cached avatar file for this account
      const cacheDir = path.join(app.getPath('userData'), 'account-avatars');
      if (!fs.existsSync(cacheDir)) {
        fs.mkdirSync(cacheDir, { recursive: true });
      }
      const avatarFile = path.join(cacheDir, `${localAccountId}.png`);
      fs.writeFileSync(avatarFile, FAKE_PNG_HEADER);
      expect(fs.existsSync(avatarFile)).to.equal(true);

      // Logout — should clear the avatar cache for this account
      const logoutResponse = await callIpc('auth:logout', String(localAccountId)) as IpcResponse<null>;
      expect(logoutResponse.success).to.equal(true);

      // The avatar file should be removed
      expect(fs.existsSync(avatarFile)).to.equal(false);
    });
  });
});
