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
exports.OAuthLoopbackServer = void 0;
const http = __importStar(require("http"));
const url = __importStar(require("url"));
const main_1 = __importDefault(require("electron-log/main"));
/**
 * Creates a local HTTP server on a random available port to receive
 * the OAuth2 redirect from Google after user authorization.
 * The server listens on 127.0.0.1 (loopback) only.
 */
class OAuthLoopbackServer {
    server = null;
    port = 0;
    /**
     * Start the loopback server and wait for the OAuth callback.
     * Returns a Promise that resolves with the authorization code and state,
     * or rejects if the user denies access or an error occurs.
     *
     * @param expectedState - The state parameter to validate against CSRF
     * @param timeoutMs - Timeout in ms before giving up (default: 5 minutes)
     */
    start(expectedState, timeoutMs = 300_000) {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((req, res) => {
                if (!req.url) {
                    res.writeHead(400);
                    res.end('Bad Request');
                    return;
                }
                const parsedUrl = url.parse(req.url, true);
                const pathname = parsedUrl.pathname;
                // Only handle the /callback path
                if (pathname !== '/callback') {
                    res.writeHead(404);
                    res.end('Not Found');
                    return;
                }
                const query = parsedUrl.query;
                const code = query['code'];
                const state = query['state'];
                const error = query['error'];
                if (error) {
                    main_1.default.warn(`OAuth callback received error: ${error}`);
                    res.writeHead(200, { 'Content-Type': 'text/html' });
                    res.end(this.getErrorHtml(error));
                    this.stop();
                    reject(new Error(`OAuth authorization denied: ${error}`));
                    return;
                }
                if (!code) {
                    main_1.default.warn('OAuth callback missing authorization code');
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(this.getErrorHtml('Missing authorization code'));
                    this.stop();
                    reject(new Error('OAuth callback missing authorization code'));
                    return;
                }
                if (state !== expectedState) {
                    main_1.default.warn('OAuth callback state mismatch (possible CSRF)');
                    res.writeHead(400, { 'Content-Type': 'text/html' });
                    res.end(this.getErrorHtml('State mismatch — possible CSRF attack'));
                    this.stop();
                    reject(new Error('OAuth state mismatch'));
                    return;
                }
                // Success — return a nice HTML page and resolve
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(this.getSuccessHtml());
                main_1.default.info('OAuth callback received authorization code');
                this.stop();
                resolve({ code, state });
            });
            // Listen on a random available port on loopback only
            this.server.listen(0, '127.0.0.1', () => {
                const addr = this.server.address();
                if (addr && typeof addr === 'object') {
                    this.port = addr.port;
                    main_1.default.info(`OAuth loopback server listening on http://127.0.0.1:${this.port}`);
                }
            });
            this.server.on('error', (err) => {
                main_1.default.error('OAuth loopback server error:', err);
                reject(err);
            });
            // Timeout — if the user takes too long, clean up
            const timeout = setTimeout(() => {
                main_1.default.warn('OAuth loopback server timed out');
                this.stop();
                reject(new Error('OAuth flow timed out — user did not complete authorization'));
            }, timeoutMs);
            // Clear timeout if server is closed for other reasons
            this.server.on('close', () => {
                clearTimeout(timeout);
            });
        });
    }
    /** Get the port the server is listening on */
    getPort() {
        return this.port;
    }
    /** Get the full redirect URI for the OAuth flow */
    getRedirectUri() {
        return `http://127.0.0.1:${this.port}/callback`;
    }
    /** Stop the server */
    stop() {
        if (this.server) {
            this.server.close();
            this.server = null;
            main_1.default.info('OAuth loopback server stopped');
        }
    }
    getSuccessHtml() {
        return `<!DOCTYPE html>
<html>
<head>
  <title>MailClient — Authentication Successful</title>
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
    <p>You can close this tab and return to MailClient.</p>
  </div>
</body>
</html>`;
    }
    getErrorHtml(error) {
        return `<!DOCTYPE html>
<html>
<head>
  <title>MailClient — Authentication Failed</title>
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
    <p>Please close this tab and try again in MailClient.</p>
  </div>
</body>
</html>`;
    }
}
exports.OAuthLoopbackServer = OAuthLoopbackServer;
//# sourceMappingURL=oauth-loopback.js.map