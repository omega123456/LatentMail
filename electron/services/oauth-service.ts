import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { shell } from 'electron';
import { LoggerService } from './logger-service';
import { OAuthLoopbackServer } from './oauth-loopback';

const log = LoggerService.getInstance();
import { CredentialService } from './credential-service';
import { DatabaseService } from './database-service';
import { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } from '../secrets';
import { clearAvatarCacheForAccount, getCachedAvatarUrl } from './avatar-cache-service';

// Google OAuth2 endpoints — overridable via environment variables for test environments.
// When env vars are set, they replace the production Google URLs entirely.
const GOOGLE_AUTH_URL_DEFAULT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL_DEFAULT = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL_DEFAULT = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_REVOKE_URL_DEFAULT = 'https://oauth2.googleapis.com/revoke';
const TEST_GOOGLE_CLIENT_ID_ENV = 'LATENTMAIL_TEST_GOOGLE_CLIENT_ID';

/** Resolve the Google token endpoint URL, with env var override support. */
function resolveTokenUrl(): string {
  return process.env['GOOGLE_TOKEN_URL'] || GOOGLE_TOKEN_URL_DEFAULT;
}

/** Resolve the Google userinfo endpoint URL, with env var override support. */
function resolveUserInfoUrl(): string {
  return process.env['GOOGLE_USERINFO_URL'] || GOOGLE_USERINFO_URL_DEFAULT;
}

/** Resolve the Google token revocation URL, with env var override support. */
function resolveRevokeUrl(): string {
  return process.env['GOOGLE_REVOKE_URL'] || GOOGLE_REVOKE_URL_DEFAULT;
}

/** Resolve the Google authorization URL, with env var override support. */
function resolveAuthUrl(): string {
  return process.env['GOOGLE_AUTH_URL'] || GOOGLE_AUTH_URL_DEFAULT;
}

interface ResolvedOAuthRequest {
  requestModule: typeof http | typeof https;
  requestUrl: URL;
  requestOptions: https.RequestOptions;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

function resolveOAuthRequest(
  urlString: string,
  requestOptions: https.RequestOptions,
): ResolvedOAuthRequest {
  const requestUrl = new URL(urlString);
  const isHttpsRequest = requestUrl.protocol === 'https:';
  const allowSelfSignedLoopback = (
    process.env['OAUTH_TEST_MODE'] === '1' &&
    isHttpsRequest &&
    isLoopbackHostname(requestUrl.hostname)
  );

  return {
    requestModule: isHttpsRequest ? https : http,
    requestUrl,
    requestOptions: {
      ...requestOptions,
      ...(allowSelfSignedLoopback ? { rejectUnauthorized: false } : {}),
    },
  };
}

/** Max retries for invalid_grant before marking account as needing re-auth (transient after sleep). */
const INVALID_GRANT_MAX_RETRIES = 2;

// Required scopes for Gmail access + user profile
const SCOPES = [
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
];

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

interface UserInfo {
  email: string;
  name: string;
  picture?: string;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export class OAuthService {
  private static instance: OAuthService;
  private clientId: string;
  private clientSecret: string;
  private loopbackServer: OAuthLoopbackServer | null = null;
  private refreshTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  private constructor() {
    const testClientIdOverride = process.env['OAUTH_TEST_MODE'] === '1'
      ? process.env[TEST_GOOGLE_CLIENT_ID_ENV]
      : undefined;
    // Prefer secrets, then env override, then built-in Desktop client ID
    this.clientId = testClientIdOverride !== undefined && testClientIdOverride.length > 0
      ? testClientIdOverride
      : GOOGLE_CLIENT_ID || process.env['GOOGLE_CLIENT_ID'] || '';
    if (!this.clientId) {
      log.warn('GOOGLE_CLIENT_ID not set — OAuth login will not work');
    }
    this.clientSecret = GOOGLE_CLIENT_SECRET;
    if (!this.clientSecret) {
      log.warn(
        'GOOGLE_CLIENT_SECRET is not set — token exchange will fail. ' +
        'Fill in the real secret in electron/secrets.ts (see electron/secrets.example.ts for instructions).'
      );
    }
  }

  static getInstance(): OAuthService {
    if (!OAuthService.instance) {
      OAuthService.instance = new OAuthService();
    }
    return OAuthService.instance;
  }

  /**
   * Initiates the full OAuth2 login flow:
   * 1. Start loopback server
   * 2. Generate PKCE challenge
   * 3. Open system browser to Google consent screen
   * 4. Wait for callback with authorization code
   * 5. Exchange code for tokens
   * 6. Fetch user profile
   * 7. Store tokens + create account record
   *
   * @returns The new account data
   */
  async login(): Promise<{ id: number; email: string; displayName: string; avatarUrl: string | null }> {
    if (!this.clientId) {
      throw new Error('GOOGLE_CLIENT_ID not configured. Set GOOGLE_CLIENT_ID in the environment or use the built-in Desktop client ID.');
    }
    log.info(`OAuth login using client ID: ${this.clientId.substring(0, 25)}...`);

    // Generate PKCE code verifier and challenge
    const codeVerifier = this.generateCodeVerifier();
    const codeChallenge = this.generateCodeChallenge(codeVerifier);
    const state = crypto.randomBytes(16).toString('hex');

    // Start loopback server to receive the redirect; wait until port is bound before building auth URL
    this.loopbackServer = new OAuthLoopbackServer();
    const { port, callbackPromise } = await this.loopbackServer.start(state);
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    // Build the authorization URL
    const authUrl = this.buildAuthUrl(redirectUri, codeChallenge, state);

    // In OAUTH_TEST_MODE, skip opening the system browser.
    // Instead, emit an 'oauth:test-auth-url' event on all BrowserWindows so that
    // test code (via TestEventBus) can programmatically trigger the callback.
    // The loopback port and state are also emitted so tests can call triggerCallback().
    if (process.env['OAUTH_TEST_MODE'] === '1') {
      log.info('[OAuthService] OAUTH_TEST_MODE enabled — emitting test event instead of opening browser');
      try {
        const { BrowserWindow } = require('electron') as typeof import('electron');
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
          if (!win.isDestroyed()) {
            win.webContents.send('oauth:test-auth-url', { authUrl, loopbackPort: port, state });
          }
        }
      } catch (emitErr) {
        log.warn('[OAuthService] Failed to emit oauth:test-auth-url event:', emitErr);
      }
    } else {
      // Open the system browser (production path)
      log.info('Opening system browser for OAuth consent...');
      await shell.openExternal(authUrl);
    }

    // Wait for the user to complete auth in the browser
    let callbackResult;
    try {
      callbackResult = await callbackPromise;
    } catch (err) {
      this.loopbackServer = null;
      throw err;
    }

    // Exchange authorization code for tokens
    log.info('Exchanging authorization code for tokens...');
    const tokens = await this.exchangeCodeForTokens(callbackResult.code, redirectUri, codeVerifier);

    // Fetch user profile
    log.info('Fetching user profile...');
    const userInfo = await this.fetchUserInfo(tokens.accessToken);

    // Store tokens securely
    const credentialService = CredentialService.getInstance();
    const db = DatabaseService.getInstance();

    // Check if account already exists
    const existingAccounts = db.getAccounts();
    const existing = existingAccounts.find(a => a.email === userInfo.email);

    let accountId: number;
    if (existing) {
      // Update existing account
      accountId = existing.id;
      db.updateAccount(accountId, userInfo.name, userInfo.picture || null);
      log.info(`Updated existing account: ${userInfo.email} (id: ${accountId})`);
    } else {
      // Create new account
      accountId = db.createAccount(userInfo.email, userInfo.name, userInfo.picture || null);
      log.info(`Created new account: ${userInfo.email} (id: ${accountId})`);
    }

    let avatarDisplayUrl: string | null = userInfo.picture || null;
    if (avatarDisplayUrl) {
      try {
        avatarDisplayUrl = await getCachedAvatarUrl(accountId, avatarDisplayUrl);
      } catch (error) {
        log.warn(`[OAuthService] Failed to resolve cached avatar for account ${accountId}:`, error);
      }
    }

    // Store tokens with the account ID
    credentialService.storeTokens(
      String(accountId),
      tokens.accessToken,
      tokens.refreshToken,
      tokens.expiresAt
    );

    // Schedule automatic token refresh
    this.scheduleTokenRefresh(String(accountId), tokens.expiresAt);

    return {
      id: accountId,
      email: userInfo.email,
      displayName: userInfo.name,
      avatarUrl: avatarDisplayUrl,
    };
  }

  /**
   * Remove an account: stop in-memory resources, revoke tokens, delete DB data, clear credentials.
   *
   * Cleanup order:
   *  1. Cancel refresh timer (prevents spurious token refreshes after removal)
   *  2. Stop IDLE watchers for the account (prevents new sync triggers)
   *  3. Cancel pending in-memory queue items for the account
   *  4. Disconnect IMAP connections for the account
   *  5. Revoke OAuth refresh token with Google
   *  6. Delete all account data from the database (wrapped in a transaction)
   *  7. Remove stored credentials from OS secure storage
   *
   * Each service cleanup step is individually wrapped in try/catch so that
   * failure in one step does not prevent the remaining steps from running.
   */
  async logout(accountId: string): Promise<void> {
    const credentialService = CredentialService.getInstance();
    const db = DatabaseService.getInstance();
    const numericAccountId = Number(accountId);

    if (!Number.isFinite(numericAccountId)) {
      log.error(`logout: invalid accountId "${accountId}" — cannot perform account removal`);
      return;
    }

    // Step 1: Cancel any pending refresh timer
    const timer = this.refreshTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(accountId);
    }

    // Step 2: Stop IDLE watchers for the account (prevents new sync triggers from its IMAP connection).
    // SyncService tracks IDLE state by string account IDs — must pass accountId (string), not
    // numericAccountId. Both INBOX IDLE and All Mail IDLE must be stopped; awaiting both ensures
    // their IMAP disconnects complete before account data is deleted below.
    try {
      const { SyncService } = require('./sync-service');
      const syncServiceInstance = SyncService.getInstance();
      await Promise.all([
        syncServiceInstance.stopIdle(accountId),
        syncServiceInstance.stopIdleAllMail(accountId),
      ]);
      log.info(`Stopped IDLE watchers for account ${accountId}`);
    } catch (err) {
      log.warn(`Failed to stop IDLE for account ${accountId} (continuing):`, err);
    }

    // Step 3: Cancel pending in-memory queue items for the account
    try {
      const { MailQueueService } = require('./mail-queue-service');
      const cancelledCount = MailQueueService.getInstance().cancelAllForAccount(numericAccountId);
      log.info(`Cancelled ${cancelledCount} pending queue items for account ${accountId}`);
    } catch (err) {
      log.warn(`Failed to cancel queue items for account ${accountId} (continuing):`, err);
    }

    // Step 3b: Cancel and disconnect body-fetch queue items for the account
    try {
      const { BodyFetchQueueService } = require('./body-fetch-queue-service');
      const cancelledBodyCount = BodyFetchQueueService.getInstance().cancelAllForAccount(numericAccountId);
      log.info(`Cancelled ${cancelledBodyCount} pending body-fetch queue items for account ${accountId}`);
      await BodyFetchQueueService.getInstance().disconnectAccount(numericAccountId);
      log.info(`Disconnected body-fetch dedicated connection for account ${accountId}`);
    } catch (err) {
      log.warn(`Failed to cancel/disconnect body-fetch queue for account ${accountId} (continuing):`, err);
    }

    // Step 4: Disconnect IMAP connections for the account
    try {
      const { ImapService } = require('./imap-service');
      await ImapService.getInstance().disconnect(accountId);
      log.info(`Disconnected IMAP for account ${accountId}`);
    } catch (err) {
      log.warn(`Failed to disconnect IMAP for account ${accountId} (continuing):`, err);
    }

    // Step 5: Revoke the refresh token with Google
    const tokens = credentialService.getTokens(accountId);
    if (tokens?.refreshToken) {
      try {
        await this.revokeToken(tokens.refreshToken);
        log.info(`Revoked OAuth token for account ${accountId}`);
      } catch (err) {
        log.warn(`Failed to revoke token for account ${accountId} (continuing with removal):`, err);
      }
    }

    // Step 6: Delete all account data from the database (transaction inside deleteAccount)
    db.deleteAccount(numericAccountId);

    // Step 7: Remove stored credentials from OS secure storage
    credentialService.removeTokens(accountId);

    // Step 8: Clear any cached avatar images for this account
    try {
      clearAvatarCacheForAccount(numericAccountId);
    } catch (error) {
      log.warn(`Failed to clear avatar cache for account ${accountId} (continuing):`, error);
    }

    log.info(`Account ${accountId} fully removed`);
  }

  /**
   * Get a valid access token for the given account.
   * Automatically refreshes if expired.
   */
  async getAccessToken(accountId: string): Promise<string> {
    const credentialService = CredentialService.getInstance();
    const tokens = credentialService.getTokens(accountId);

    if (!tokens) {
      throw new Error(`No tokens found for account ${accountId}`);
    }

    // If token is still valid (with 5-minute buffer), return it
    const now = Date.now();
    if (tokens.expiresAt > now + 5 * 60 * 1000) {
      return tokens.accessToken;
    }

    // Token expired or about to expire — refresh it
    log.info(`Access token for account ${accountId} expired, refreshing...`);
    return this.refreshAccessToken(accountId);
  }

  /**
   * Refresh the access token using the refresh token.
   * Uses exponential backoff on failure.
   */
  async refreshAccessToken(accountId: string, retryCount: number = 0): Promise<string> {
    const credentialService = CredentialService.getInstance();
    const tokens = credentialService.getTokens(accountId);

    if (!tokens?.refreshToken) {
      throw new Error(`No refresh token for account ${accountId}`);
    }

    try {
      const newTokens = await this.refreshTokenRequest(tokens.refreshToken);

      // Update stored tokens (refresh token may or may not be returned)
      credentialService.storeTokens(
        accountId,
        newTokens.accessToken,
        newTokens.refreshToken || tokens.refreshToken,
        newTokens.expiresAt
      );

      // Reschedule automatic refresh
      this.scheduleTokenRefresh(accountId, newTokens.expiresAt);

      log.info(`Access token refreshed for account ${accountId}`);

      // Resume the mail queue if it was paused due to auth failure
      try {
        const { MailQueueService } = require('./mail-queue-service');
        MailQueueService.getInstance().resumeAccount(Number(accountId));
      } catch {
        // Queue may not be initialized yet
      }

      return newTokens.accessToken;
    } catch (err: any) {
      // invalid_grant can be transient after sleep (clock skew, keychain). Retry before marking re-auth.
      if (err.message?.includes('invalid_grant')) {
        if (retryCount < INVALID_GRANT_MAX_RETRIES) {
          const delayMs = retryCount === 0 ? 15_000 : 30_000;
          log.warn(
            `Token refresh returned invalid_grant for account ${accountId}, retrying in ${delayMs / 1000}s (attempt ${retryCount + 1}/${INVALID_GRANT_MAX_RETRIES + 1})`
          );
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          return this.refreshAccessToken(accountId, retryCount + 1);
        }
        log.error(`Refresh token revoked for account ${accountId} — needs re-authentication`);
        const db = DatabaseService.getInstance();
        db.setAccountNeedsReauth(Number(accountId));
        throw new Error(`Account ${accountId} needs re-authentication`);
      }

      // Retryable error — exponential backoff
      const maxRetries = 5;
      if (retryCount < maxRetries) {
        const delay = Math.min(1000 * Math.pow(2, retryCount), 60_000);
        log.warn(`Token refresh failed for account ${accountId}, retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        return this.refreshAccessToken(accountId, retryCount + 1);
      }

      throw err;
    }
  }

  /**
   * Schedule automatic token refresh before expiry.
   */
  private scheduleTokenRefresh(accountId: string, expiresAt: number): void {
    // Cancel existing timer
    const existing = this.refreshTimers.get(accountId);
    if (existing) clearTimeout(existing);

    // Refresh 5 minutes before expiry
    const refreshAt = expiresAt - Date.now() - 5 * 60 * 1000;
    if (refreshAt <= 0) return; // Already expired, will refresh on next use

    const timer = setTimeout(async () => {
      try {
        await this.refreshAccessToken(accountId);
      } catch (err) {
        log.error(`Automatic token refresh failed for account ${accountId}:`, err);
      }
    }, refreshAt);

    this.refreshTimers.set(accountId, timer);
    log.debug(`Token refresh scheduled for account ${accountId} in ${Math.round(refreshAt / 1000)}s`);
  }

  /**
   * On app start, schedule refresh timers for all existing accounts.
   */
  initializeRefreshTimers(): void {
    const credentialService = CredentialService.getInstance();
    const db = DatabaseService.getInstance();
    const accounts = db.getAccounts();

    for (const account of accounts) {
      const tokens = credentialService.getTokens(String(account.id));
      if (tokens) {
        this.scheduleTokenRefresh(String(account.id), tokens.expiresAt);
      }
    }

    log.info(`Initialized refresh timers for ${accounts.length} accounts`);
  }

  // ---- Private helpers ----

  private generateCodeVerifier(): string {
    // 43-128 character URL-safe string (RFC 7636)
    return crypto.randomBytes(32).toString('base64url');
  }

  private generateCodeChallenge(verifier: string): string {
    return crypto.createHash('sha256').update(verifier).digest('base64url');
  }

  private buildAuthUrl(redirectUri: string, codeChallenge: string, state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: SCOPES.join(' '),
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state: state,
      access_type: 'offline',     // Get a refresh token
      prompt: 'consent',          // Always show consent to get refresh token
    });

    return `${resolveAuthUrl()}?${params.toString()}`;
  }

  private exchangeCodeForTokens(code: string, redirectUri: string, codeVerifier: string): Promise<OAuthTokens> {
    const params: Record<string, string> = {
      code,
      client_id: this.clientId,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: codeVerifier,
    };
    // Only include client_secret when it is set; if empty, PKCE-only flow is used
    // (sending an empty string causes Google to reject with invalid_client)
    if (this.clientSecret) {
      params['client_secret'] = this.clientSecret;
    }
    const body = new URLSearchParams(params).toString();

    return new Promise((resolve, reject) => {
      const { requestModule, requestUrl, requestOptions } = resolveOAuthRequest(resolveTokenUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      });
      const req = requestModule.request(requestUrl, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed: TokenResponse = JSON.parse(data);
            if (res.statusCode !== 200 || !parsed.access_token) {
              reject(new Error(`Token exchange failed: ${data}`));
              return;
            }
            resolve({
              accessToken: parsed.access_token,
              refreshToken: parsed.refresh_token || '',
              expiresAt: Date.now() + parsed.expires_in * 1000,
            });
          } catch (err) {
            reject(new Error(`Failed to parse token response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private refreshTokenRequest(refreshToken: string): Promise<OAuthTokens> {
    const params: Record<string, string> = {
      refresh_token: refreshToken,
      client_id: this.clientId,
      grant_type: 'refresh_token',
    };
    // Only include client_secret when it is set; if empty, PKCE-only flow is used
    if (this.clientSecret) {
      params['client_secret'] = this.clientSecret;
    }
    const body = new URLSearchParams(params).toString();

    return new Promise((resolve, reject) => {
      const { requestModule, requestUrl, requestOptions } = resolveOAuthRequest(resolveTokenUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      });
      const req = requestModule.request(requestUrl, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed: TokenResponse = JSON.parse(data);
            if (res.statusCode !== 200 || !parsed.access_token) {
              reject(new Error(data.includes('invalid_grant') ? 'invalid_grant' : `Token refresh failed: ${data}`));
              return;
            }
            resolve({
              accessToken: parsed.access_token,
              refreshToken: parsed.refresh_token || '',
              expiresAt: Date.now() + parsed.expires_in * 1000,
            });
          } catch (err) {
            reject(new Error(`Failed to parse refresh response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private fetchUserInfo(accessToken: string): Promise<UserInfo> {
    return new Promise((resolve, reject) => {
      const { requestModule, requestUrl, requestOptions } = resolveOAuthRequest(resolveUserInfoUrl(), {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      });
      const req = requestModule.request(requestUrl, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (res.statusCode !== 200 || !parsed.email) {
              reject(new Error(`Failed to fetch user info: ${data}`));
              return;
            }
            resolve({
              email: parsed.email,
              name: parsed.name || parsed.email,
              picture: parsed.picture || undefined,
            });
          } catch (err) {
            reject(new Error(`Failed to parse user info: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  private revokeToken(token: string): Promise<void> {
    const body = `token=${encodeURIComponent(token)}`;

    return new Promise((resolve, reject) => {
      const { requestModule, requestUrl, requestOptions } = resolveOAuthRequest(resolveRevokeUrl(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      });
      const req = requestModule.request(requestUrl, requestOptions, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            reject(new Error(`Token revocation failed: ${data}`));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }
}
