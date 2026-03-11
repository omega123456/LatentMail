import * as http from 'http';
import { LoggerService } from './logger-service';

const log = LoggerService.getInstance();

export interface OAuthCallbackResult {
  code: string;
  state: string;
}

/**
 * Creates a local HTTP server on a random available port to receive
 * the OAuth2 redirect from Google after user authorization.
 * The server listens on 127.0.0.1 (loopback) only.
 */
export class OAuthLoopbackServer {
  private server: http.Server | null = null;
  private port: number = 0;

  /**
   * Start the loopback server. Resolves when the server is listening (port is bound);
   * returns the confirmed port and a separate promise that resolves when the OAuth callback
   * is received. Build the redirect URI from the returned port before opening the auth URL.
   *
   * @param expectedState - The state parameter to validate against CSRF
   * @param timeoutMs - Timeout in ms before giving up (default: 5 minutes)
   * @returns Object with bound port and a promise that resolves with the callback result
   */
  async start(expectedState: string, timeoutMs: number = 300_000): Promise<{ port: number; callbackPromise: Promise<OAuthCallbackResult> }> {
    let resolveCallback: (value: OAuthCallbackResult) => void;
    let rejectCallback: (reason: Error) => void;
    const callbackPromise = new Promise<OAuthCallbackResult>((resolve, reject) => {
      resolveCallback = resolve;
      rejectCallback = reject;
    });

    const port = await new Promise<number>((resolveListen, rejectListen) => {
      this.server = http.createServer((req, res) => {
        if (!req.url) {
          res.writeHead(400);
          res.end('Bad Request');
          return;
        }

        let requestUrl: URL;
        try {
          requestUrl = new URL(req.url, 'http://localhost');
        } catch {
          res.writeHead(400);
          res.end('Bad Request');
          return;
        }
        const pathname = requestUrl.pathname;

        // Only handle the /callback path
        if (pathname !== '/callback') {
          res.writeHead(404);
          res.end('Not Found');
          return;
        }

        const query = requestUrl.searchParams;
        const code = query.get('code') ?? undefined;
        const state = query.get('state') ?? undefined;
        const error = query.get('error') ?? undefined;

        if (error) {
          log.warn(`OAuth callback received error: ${error}`);
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(this.getErrorHtml(error));
          this.stop();
          rejectCallback(new Error(`OAuth authorization denied: ${error}`));
          return;
        }

        if (!code) {
          log.warn('OAuth callback missing authorization code');
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(this.getErrorHtml('Missing authorization code'));
          this.stop();
          rejectCallback(new Error('OAuth callback missing authorization code'));
          return;
        }

        if (state !== expectedState) {
          log.warn('OAuth callback state mismatch (possible CSRF)');
          res.writeHead(400, { 'Content-Type': 'text/html' });
          res.end(this.getErrorHtml('State mismatch — possible CSRF attack'));
          this.stop();
          rejectCallback(new Error('OAuth state mismatch'));
          return;
        }

        // Success — return a nice HTML page and resolve
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(this.getSuccessHtml());

        log.info('OAuth callback received authorization code');
        this.stop();
        resolveCallback({ code, state });
      });

      // Listen on a random available port on loopback only
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        if (addr && typeof addr === 'object') {
          this.port = addr.port;
          log.info(`OAuth loopback server listening on http://127.0.0.1:${this.port}`);
          resolveListen(this.port);
        } else {
          rejectListen(new Error('Could not get server address'));
        }
      });

      this.server.on('error', (err) => {
        log.error('OAuth loopback server error:', err);
        rejectCallback(err);
        rejectListen(err);
      });

      // Timeout — if the user takes too long, clean up
      const timeout = setTimeout(() => {
        log.warn('OAuth loopback server timed out');
        this.stop();
        rejectCallback(new Error('OAuth flow timed out — user did not complete authorization'));
      }, timeoutMs);

      // Clear timeout if server is closed for other reasons
      this.server.on('close', () => {
        clearTimeout(timeout);
      });
    });

    return { port, callbackPromise };
  }

  /** Get the port the server is listening on */
  getPort(): number {
    return this.port;
  }

  /** Get the full redirect URI for the OAuth flow */
  getRedirectUri(): string {
    return `http://127.0.0.1:${this.port}/callback`;
  }

  /** Stop the server */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      log.info('OAuth loopback server stopped');
    }
  }

  private getSuccessHtml(): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>LatentMail — Authentication Successful</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #fafafa; color: #212121; }
    .card { text-align: center; padding: 48px; background: white; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); max-width: 400px; }
    h1 { color: #388E3C; margin-bottom: 8px; }
    p { color: #666; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication Successful</h1>
    <p>You can close this tab and return to LatentMail.</p>
  </div>
</body>
</html>`;
  }

  private getErrorHtml(error: string): string {
    return `<!DOCTYPE html>
<html>
<head>
  <title>LatentMail — Authentication Failed</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #fafafa; color: #212121; }
    .card { text-align: center; padding: 48px; background: white; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); max-width: 400px; }
    h1 { color: #D32F2F; margin-bottom: 8px; }
    p { color: #666; }
    code { background: #f5f5f5; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authentication Failed</h1>
    <p>Error: <code>${error}</code></p>
    <p>Please close this tab and try again in LatentMail.</p>
  </div>
</body>
</html>`;
  }
}
