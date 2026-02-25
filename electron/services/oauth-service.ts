import * as crypto from 'crypto';
import * as https from 'https';
import { shell } from 'electron';
import { LoggerService } from './logger-service';
import { OAuthLoopbackServer } from './oauth-loopback';

const log = LoggerService.getInstance();
import { CredentialService } from './credential-service';
import { DatabaseService } from './database-service';
import { GOOGLE_CLIENT_ID_DESKTOP, GOOGLE_CLIENT_SECRET } from '../config';

// Google OAuth2 endpoints
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

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
    // Prefer baked-in Desktop client ID so env (e.g. .env loaded by IDE) cannot override with an old Web client ID
    this.clientId = GOOGLE_CLIENT_ID_DESKTOP || process.env['GOOGLE_CLIENT_ID'] || '';
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

    // Open the system browser
    log.info('Opening system browser for OAuth consent...');
    await shell.openExternal(authUrl);

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
      avatarUrl: userInfo.picture || null,
    };
  }

  /**
   * Remove an account: revoke tokens, delete from DB, clear credentials.
   */
  async logout(accountId: string): Promise<void> {
    const credentialService = CredentialService.getInstance();
    const db = DatabaseService.getInstance();

    // Cancel any pending refresh timer
    const timer = this.refreshTimers.get(accountId);
    if (timer) {
      clearTimeout(timer);
      this.refreshTimers.delete(accountId);
    }

    // Revoke the refresh token with Google
    const tokens = credentialService.getTokens(accountId);
    if (tokens?.refreshToken) {
      try {
        await this.revokeToken(tokens.refreshToken);
        log.info(`Revoked OAuth token for account ${accountId}`);
      } catch (err) {
        log.warn(`Failed to revoke token for account ${accountId} (continuing with removal):`, err);
      }
    }

    // Delete all account data from the database
    db.deleteAccount(Number(accountId));

    // Remove stored credentials
    credentialService.removeTokens(accountId);

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
      // If the refresh token is revoked, mark account as needing re-auth
      if (err.message?.includes('invalid_grant')) {
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

    return `${GOOGLE_AUTH_URL}?${params.toString()}`;
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
      const req = https.request(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
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
      const req = https.request(GOOGLE_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
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
      const req = https.request(GOOGLE_USERINFO_URL, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
        },
      }, (res) => {
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
      const req = https.request(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      }, (res) => {
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
