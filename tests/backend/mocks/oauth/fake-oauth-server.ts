/**
 * fake-oauth-server.ts — HTTPS fake OAuth2 server for backend tests.
 *
 * Implements the subset of Google OAuth2 endpoints that OAuthService uses:
 *   POST /o/oauth2/token   — authorization_code exchange and refresh_token grant
 *   GET  /oauth2/v3/userinfo — user profile (Bearer token required)
 *   POST /o/oauth2/revoke   — token revocation
 *
 * Uses a self-signed TLS certificate (generated via the `selfsigned` package at
 * startup) so that HTTPS calls from OAuthService are satisfied.
 * OAuthService explicitly allows self-signed TLS only for loopback HTTPS test
 * endpoints while OAUTH_TEST_MODE=1, avoiding a global TLS override.
 *
 * Usage in tests:
 *   const server = new FakeOAuthServer();
 *   const port = await server.start();
 *   process.env['OAUTH_TOKEN_URL'] = server.getBaseUrl() + '/o/oauth2/token';
 *   // ... run test ...
 *   await server.stop();
 */

import * as https from 'https';
import * as http from 'http';
import { DateTime } from 'luxon';

// ---- Exported configuration interfaces ----

/**
 * Configures what tokens the fake server returns on a successful exchange or
 * refresh request.
 */
export interface FakeTokenConfig {
  accessToken: string;
  refreshToken: string;
  /** How many seconds until the access token expires */
  expiresIn: number;
  tokenType?: string;
  scope?: string;
}

/**
 * Configures the user profile returned by GET /oauth2/v3/userinfo.
 */
export interface FakeUserInfo {
  email: string;
  name: string;
  picture?: string;
  /** Stable subject identifier (opaque Google user ID) */
  sub?: string;
}

/**
 * Configures optional error simulation and response delays for individual
 * endpoints.
 */
export interface OAuthErrorConfig {
  /** If set, POST /o/oauth2/token returns this error code with HTTP 400 */
  tokenError?: string;
  /** If set, GET /oauth2/v3/userinfo returns this error with HTTP 401 */
  userInfoError?: string;
  /** If set, POST /o/oauth2/revoke returns this error with HTTP 400 */
  revokeError?: string;
  /** If set, adds an artificial delay (in ms) before responding to /o/oauth2/token */
  tokenDelayMs?: number;
}

/**
 * A record of a single HTTP request received by the fake server.
 */
export interface CapturedRequest {
  endpoint: string;
  body: string;
  timestamp: string;
}

// ---- Internal type for the selfsigned package ----

interface SelfsignedPems {
  private: string;
  public: string;
  cert: string;
  fingerprint: string;
}

interface SelfsignedModule {
  generate(
    attrs?: Array<{ name: string; value: string }>,
    opts?: { days?: number; keySize?: number; keyType?: 'rsa' | 'ec' },
  ): Promise<SelfsignedPems>;
}

// ---- Main class ----

/**
 * A local HTTPS server that mimics the Google OAuth2 endpoints used by
 * OAuthService. Start it, point OAuthService at its base URL, and it will
 * respond with configurable token and user-profile payloads.
 */
export class FakeOAuthServer {
  private server: https.Server | null = null;
  private port: number = 0;

  private tokenConfig: FakeTokenConfig = {
    accessToken: 'fake-access-token-12345',
    refreshToken: 'fake-refresh-token-67890',
    expiresIn: 3600,
    tokenType: 'Bearer',
    scope: 'https://mail.google.com/',
  };

  private userInfo: FakeUserInfo = {
    email: 'test@example.com',
    name: 'Test User',
    sub: '12345678901234567890',
  };

  private errorConfig: OAuthErrorConfig = {};

  private validCodes: Set<string> = new Set(['test_code']);

  private capturedRequests: CapturedRequest[] = [];

  /**
   * Generate a self-signed TLS certificate and start the HTTPS server on a
   * random available port on 127.0.0.1.
   *
   * @returns Promise resolving with the assigned port number.
   */
  async start(): Promise<number> {
    // Generate a self-signed cert for localhost.
    // selfsigned v5+ returns a Promise (async only).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const selfsigned = require('selfsigned') as SelfsignedModule;
    const pems = await selfsigned.generate(
      [{ name: 'commonName', value: 'localhost' }],
      { days: 365, keySize: 2048 },
    );

    return new Promise<number>((resolve, reject) => {
      this.server = https.createServer(
        { key: pems.private, cert: pems.cert },
        (request: http.IncomingMessage, response: http.ServerResponse) => {
          this.handleRequest(request, response);
        },
      );

      this.server.listen(0, '127.0.0.1', () => {
        const address = this.server!.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
          resolve(this.port);
        } else {
          reject(new Error('FakeOAuthServer: failed to get port after server.listen()'));
        }
      });

      this.server.on('error', (serverError: Error) => {
        reject(serverError);
      });
    });
  }

  /**
   * Shut down the HTTPS server and release the port.
   * @returns Promise resolving when the server is fully closed.
   */
  async stop(): Promise<void> {
    return new Promise<void>((resolve) => {
      if (this.server) {
        this.server.close(() => {
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // ---- Request routing ----

  private handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
    // Use WHATWG URL API to extract the pathname (url.parse is deprecated in Node 22+)
    // The base is synthetic — we only need the pathname component.
    let pathname = '/';
    try {
      pathname = new URL(request.url ?? '/', 'https://localhost').pathname;
    } catch {
      pathname = (request.url ?? '/').split('?')[0];
    }

    const chunks: Buffer[] = [];

    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    request.on('end', (): void => {
      const body = Buffer.concat(chunks).toString('utf8');
      this.capturedRequests.push({ endpoint: pathname, body, timestamp: DateTime.now().toISO()! });

      // Route to the appropriate endpoint handler
      if (pathname === '/o/oauth2/token' && request.method === 'POST') {
        if (this.errorConfig.tokenDelayMs) {
          setTimeout((): void => {
            this.handleTokenRequest(body, response);
          }, this.errorConfig.tokenDelayMs);
        } else {
          this.handleTokenRequest(body, response);
        }
      } else if (pathname === '/oauth2/v3/userinfo' && request.method === 'GET') {
        this.handleUserInfoRequest(request, response);
      } else if (pathname === '/o/oauth2/revoke' && request.method === 'POST') {
        this.handleRevokeRequest(response);
      } else {
        response.writeHead(404, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'not_found', path: pathname }));
      }
    });

    request.on('error', (requestError: Error) => {
      console.warn('[FakeOAuthServer] Request error:', requestError.message);
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'internal_error' }));
    });
  }

  // ---- Endpoint handlers ----

  private handleTokenRequest(body: string, response: http.ServerResponse): void {
    if (this.errorConfig.tokenError) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: this.errorConfig.tokenError }));
      return;
    }

    const params = new URLSearchParams(body);
    const grantType = params.get('grant_type');

    // Validate grant_type — only authorization_code and refresh_token are supported
    if (grantType !== 'authorization_code' && grantType !== 'refresh_token') {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unsupported_grant_type' }));
      return;
    }

    if (grantType === 'authorization_code') {
      const code = params.get('code');
      if (!code) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      if (!this.validCodes.has(code)) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(
          JSON.stringify({
            error: 'invalid_grant',
            error_description: 'Invalid authorization code',
          }),
        );
        return;
      }
    }

    if (grantType === 'refresh_token') {
      const refreshToken = params.get('refresh_token');
      if (!refreshToken) {
        response.writeHead(400, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
    }

    // Both authorization_code exchange and refresh_token grant return the same shape
    const expiresIn = this.tokenConfig.expiresIn;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        access_token: this.tokenConfig.accessToken,
        refresh_token: this.tokenConfig.refreshToken,
        expires_in: expiresIn,
        expiry_date: DateTime.now().plus({ seconds: expiresIn }).toMillis(),
        token_type: this.tokenConfig.tokenType ?? 'Bearer',
        scope: this.tokenConfig.scope ?? 'https://mail.google.com/',
      }),
    );
  }

  private handleUserInfoRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): void {
    // Validate Authorization: Bearer <token> header
    const authHeader = request.headers['authorization'] ?? '';
    if (!authHeader.startsWith('Bearer ')) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }

    // Validate that the bearer token matches the configured access token.
    // Any other token value indicates an access-token propagation bug.
    const bearerToken = authHeader.slice('Bearer '.length);
    if (bearerToken !== this.tokenConfig.accessToken) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }

    if (this.errorConfig.userInfoError) {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: this.errorConfig.userInfoError }));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(
      JSON.stringify({
        email: this.userInfo.email,
        name: this.userInfo.name,
        picture: this.userInfo.picture ?? null,
        sub: this.userInfo.sub ?? '12345678901234567890',
      }),
    );
  }

  private handleRevokeRequest(response: http.ServerResponse): void {
    if (this.errorConfig.revokeError) {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: this.errorConfig.revokeError }));
      return;
    }

    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  }

  // ---- Test-control API ----

  /**
   * Simulate the browser completing the OAuth redirect back to the loopback
   * server. Makes an HTTP GET to the OAuthLoopbackServer's callback URL with
   * the given authorization code (or error).
   *
   * @param loopbackPort - Port the OAuthLoopbackServer is listening on.
   * @param state - The `state` parameter echoed back from the authorization URL.
   * @param options.code - Override the authorization code (default: 'test_code').
   * @param options.error - If set, simulate a user-denied or error response.
   */
  triggerCallback(
    loopbackPort: number,
    state: string,
    options?: { error?: string; code?: string },
  ): Promise<void> {
    const code = options?.code ?? 'test_code';
    const query = options?.error
      ? `error=${encodeURIComponent(options.error)}&state=${encodeURIComponent(state)}`
      : `code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`;

    const callbackUrl = `http://127.0.0.1:${loopbackPort}/callback?${query}`;

    return new Promise<void>((resolve, reject) => {
      const request = http.get(callbackUrl, (callbackResponse: http.IncomingMessage) => {
        // Drain the response body so the socket can be reused / closed cleanly
        callbackResponse.resume();
        callbackResponse.on('end', () => {
          resolve();
        });
      });

      request.on('error', (requestError: Error) => {
        reject(requestError);
      });
    });
  }

  /**
   * Override one or more fields of the token response.
   * Unspecified fields retain their current values.
   */
  setTokenConfig(config: Partial<FakeTokenConfig>): void {
    this.tokenConfig = { ...this.tokenConfig, ...config };
  }

  /**
   * Override one or more fields of the user-info response.
   * Unspecified fields retain their current values.
   */
  setUserInfo(info: Partial<FakeUserInfo>): void {
    this.userInfo = { ...this.userInfo, ...info };
  }

  /**
   * Configure error simulation for specific endpoints.
   * Pass `{}` to clear all errors.
   */
  setErrorConfig(config: OAuthErrorConfig): void {
    this.errorConfig = config;
  }

  /**
   * Register an additional authorization code as valid for the
   * authorization_code grant type.
   */
  addValidCode(code: string): void {
    this.validCodes.add(code);
  }

  /**
   * Reset all configuration and captured state to defaults.
   * Does not stop or restart the server.
   */
  reset(): void {
    this.tokenConfig = {
      accessToken: 'fake-access-token-12345',
      refreshToken: 'fake-refresh-token-67890',
      expiresIn: 3600,
      tokenType: 'Bearer',
      scope: 'https://mail.google.com/',
    };
    this.userInfo = {
      email: 'test@example.com',
      name: 'Test User',
      sub: '12345678901234567890',
    };
    this.errorConfig = {};
    this.validCodes = new Set(['test_code']);
    this.capturedRequests = [];
  }

  /**
   * Return a snapshot of all HTTP requests this server received, in order.
   * Useful for asserting that OAuthService sent the expected requests.
   */
  getCapturedRequests(): CapturedRequest[] {
    return [...this.capturedRequests];
  }

  /**
   * Return the TCP port the server is currently bound to (0 before start()).
   */
  getPort(): number {
    return this.port;
  }

  /**
   * Return the base HTTPS URL for this server.
   * Use this to override OAuth endpoint env vars in tests.
   * Example: `https://127.0.0.1:12345`
   */
  getBaseUrl(): string {
    return `https://127.0.0.1:${this.port}`;
  }
}
