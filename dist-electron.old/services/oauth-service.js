"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.OAuthService = void 0;
const crypto = __importStar(require("crypto"));
const https = __importStar(require("https"));
const electron_1 = require("electron");
const main_1 = __importDefault(require("electron-log/main"));
const oauth_loopback_1 = require("./oauth-loopback");
const credential_service_1 = require("./credential-service");
const database_service_1 = require("./database-service");
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
class OAuthService {
    static instance;
    clientId;
    loopbackServer = null;
    refreshTimers = new Map();
    constructor() {
        this.clientId = process.env['GOOGLE_CLIENT_ID'] || '';
        if (!this.clientId) {
            main_1.default.warn('GOOGLE_CLIENT_ID not set — OAuth login will not work');
        }
    }
    static getInstance() {
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
    async login() {
        if (!this.clientId) {
            throw new Error('GOOGLE_CLIENT_ID not configured. Set it in .env file.');
        }
        // Generate PKCE code verifier and challenge
        const codeVerifier = this.generateCodeVerifier();
        const codeChallenge = this.generateCodeChallenge(codeVerifier);
        const state = crypto.randomBytes(16).toString('hex');
        // Start loopback server to receive the redirect
        this.loopbackServer = new oauth_loopback_1.OAuthLoopbackServer();
        const callbackPromise = this.loopbackServer.start(state);
        // We need to wait for the server to start listening before we can get the redirect URI
        // Small delay to ensure the server is ready
        await new Promise(resolve => setTimeout(resolve, 100));
        const redirectUri = this.loopbackServer.getRedirectUri();
        // Build the authorization URL
        const authUrl = this.buildAuthUrl(redirectUri, codeChallenge, state);
        // Open the system browser
        main_1.default.info('Opening system browser for OAuth consent...');
        await electron_1.shell.openExternal(authUrl);
        // Wait for the user to complete auth in the browser
        let callbackResult;
        try {
            callbackResult = await callbackPromise;
        }
        catch (err) {
            this.loopbackServer = null;
            throw err;
        }
        // Exchange authorization code for tokens
        main_1.default.info('Exchanging authorization code for tokens...');
        const tokens = await this.exchangeCodeForTokens(callbackResult.code, redirectUri, codeVerifier);
        // Fetch user profile
        main_1.default.info('Fetching user profile...');
        const userInfo = await this.fetchUserInfo(tokens.accessToken);
        // Store tokens securely
        const credentialService = credential_service_1.CredentialService.getInstance();
        const db = database_service_1.DatabaseService.getInstance();
        // Check if account already exists
        const existingAccounts = db.getAccounts();
        const existing = existingAccounts.find(a => a.email === userInfo.email);
        let accountId;
        if (existing) {
            // Update existing account
            accountId = existing.id;
            db.updateAccount(accountId, userInfo.name, userInfo.picture || null);
            main_1.default.info(`Updated existing account: ${userInfo.email} (id: ${accountId})`);
        }
        else {
            // Create new account
            accountId = db.createAccount(userInfo.email, userInfo.name, userInfo.picture || null);
            main_1.default.info(`Created new account: ${userInfo.email} (id: ${accountId})`);
        }
        // Store tokens with the account ID
        credentialService.storeTokens(String(accountId), tokens.accessToken, tokens.refreshToken, tokens.expiresAt);
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
    async logout(accountId) {
        const credentialService = credential_service_1.CredentialService.getInstance();
        const db = database_service_1.DatabaseService.getInstance();
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
                main_1.default.info(`Revoked OAuth token for account ${accountId}`);
            }
            catch (err) {
                main_1.default.warn(`Failed to revoke token for account ${accountId} (continuing with removal):`, err);
            }
        }
        // Delete all account data from the database
        db.deleteAccount(Number(accountId));
        // Remove stored credentials
        credentialService.removeTokens(accountId);
        main_1.default.info(`Account ${accountId} fully removed`);
    }
    /**
     * Get a valid access token for the given account.
     * Automatically refreshes if expired.
     */
    async getAccessToken(accountId) {
        const credentialService = credential_service_1.CredentialService.getInstance();
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
        main_1.default.info(`Access token for account ${accountId} expired, refreshing...`);
        return this.refreshAccessToken(accountId);
    }
    /**
     * Refresh the access token using the refresh token.
     * Uses exponential backoff on failure.
     */
    async refreshAccessToken(accountId, retryCount = 0) {
        const credentialService = credential_service_1.CredentialService.getInstance();
        const tokens = credentialService.getTokens(accountId);
        if (!tokens?.refreshToken) {
            throw new Error(`No refresh token for account ${accountId}`);
        }
        try {
            const newTokens = await this.refreshTokenRequest(tokens.refreshToken);
            // Update stored tokens (refresh token may or may not be returned)
            credentialService.storeTokens(accountId, newTokens.accessToken, newTokens.refreshToken || tokens.refreshToken, newTokens.expiresAt);
            // Reschedule automatic refresh
            this.scheduleTokenRefresh(accountId, newTokens.expiresAt);
            main_1.default.info(`Access token refreshed for account ${accountId}`);
            return newTokens.accessToken;
        }
        catch (err) {
            // If the refresh token is revoked, mark account as needing re-auth
            if (err.message?.includes('invalid_grant')) {
                main_1.default.error(`Refresh token revoked for account ${accountId} — needs re-authentication`);
                const db = database_service_1.DatabaseService.getInstance();
                db.setAccountNeedsReauth(Number(accountId));
                throw new Error(`Account ${accountId} needs re-authentication`);
            }
            // Retryable error — exponential backoff
            const maxRetries = 5;
            if (retryCount < maxRetries) {
                const delay = Math.min(1000 * Math.pow(2, retryCount), 60_000);
                main_1.default.warn(`Token refresh failed for account ${accountId}, retrying in ${delay}ms (attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, delay));
                return this.refreshAccessToken(accountId, retryCount + 1);
            }
            throw err;
        }
    }
    /**
     * Schedule automatic token refresh before expiry.
     */
    scheduleTokenRefresh(accountId, expiresAt) {
        // Cancel existing timer
        const existing = this.refreshTimers.get(accountId);
        if (existing)
            clearTimeout(existing);
        // Refresh 5 minutes before expiry
        const refreshAt = expiresAt - Date.now() - 5 * 60 * 1000;
        if (refreshAt <= 0)
            return; // Already expired, will refresh on next use
        const timer = setTimeout(async () => {
            try {
                await this.refreshAccessToken(accountId);
            }
            catch (err) {
                main_1.default.error(`Automatic token refresh failed for account ${accountId}:`, err);
            }
        }, refreshAt);
        this.refreshTimers.set(accountId, timer);
        main_1.default.debug(`Token refresh scheduled for account ${accountId} in ${Math.round(refreshAt / 1000)}s`);
    }
    /**
     * On app start, schedule refresh timers for all existing accounts.
     */
    initializeRefreshTimers() {
        const credentialService = credential_service_1.CredentialService.getInstance();
        const db = database_service_1.DatabaseService.getInstance();
        const accounts = db.getAccounts();
        for (const account of accounts) {
            const tokens = credentialService.getTokens(String(account.id));
            if (tokens) {
                this.scheduleTokenRefresh(String(account.id), tokens.expiresAt);
            }
        }
        main_1.default.info(`Initialized refresh timers for ${accounts.length} accounts`);
    }
    // ---- Private helpers ----
    generateCodeVerifier() {
        // 43-128 character URL-safe string (RFC 7636)
        return crypto.randomBytes(32).toString('base64url');
    }
    generateCodeChallenge(verifier) {
        return crypto.createHash('sha256').update(verifier).digest('base64url');
    }
    buildAuthUrl(redirectUri, codeChallenge, state) {
        const params = new URLSearchParams({
            client_id: this.clientId,
            redirect_uri: redirectUri,
            response_type: 'code',
            scope: SCOPES.join(' '),
            code_challenge: codeChallenge,
            code_challenge_method: 'S256',
            state: state,
            access_type: 'offline', // Get a refresh token
            prompt: 'consent', // Always show consent to get refresh token
        });
        return `${GOOGLE_AUTH_URL}?${params.toString()}`;
    }
    exchangeCodeForTokens(code, redirectUri, codeVerifier) {
        const body = new URLSearchParams({
            code,
            client_id: this.clientId,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: codeVerifier,
        }).toString();
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
                        const parsed = JSON.parse(data);
                        if (res.statusCode !== 200 || !parsed.access_token) {
                            reject(new Error(`Token exchange failed: ${data}`));
                            return;
                        }
                        resolve({
                            accessToken: parsed.access_token,
                            refreshToken: parsed.refresh_token || '',
                            expiresAt: Date.now() + parsed.expires_in * 1000,
                        });
                    }
                    catch (err) {
                        reject(new Error(`Failed to parse token response: ${data}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    refreshTokenRequest(refreshToken) {
        const body = new URLSearchParams({
            refresh_token: refreshToken,
            client_id: this.clientId,
            grant_type: 'refresh_token',
        }).toString();
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
                        const parsed = JSON.parse(data);
                        if (res.statusCode !== 200 || !parsed.access_token) {
                            reject(new Error(data.includes('invalid_grant') ? 'invalid_grant' : `Token refresh failed: ${data}`));
                            return;
                        }
                        resolve({
                            accessToken: parsed.access_token,
                            refreshToken: parsed.refresh_token || '',
                            expiresAt: Date.now() + parsed.expires_in * 1000,
                        });
                    }
                    catch (err) {
                        reject(new Error(`Failed to parse refresh response: ${data}`));
                    }
                });
            });
            req.on('error', reject);
            req.write(body);
            req.end();
        });
    }
    fetchUserInfo(accessToken) {
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
                    }
                    catch (err) {
                        reject(new Error(`Failed to parse user info: ${data}`));
                    }
                });
            });
            req.on('error', reject);
            req.end();
        });
    }
    revokeToken(token) {
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
                    }
                    else {
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
exports.OAuthService = OAuthService;
//# sourceMappingURL=oauth-service.js.map