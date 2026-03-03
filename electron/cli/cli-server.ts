import * as net from 'net';
import * as fs from 'fs';
import { LoggerService } from '../services/logger-service';
import { getPipePath } from './pipe-path';
import { dispatchCommand } from './commands';

const log = LoggerService.getInstance();

/** JSON request received from CLI client. */
interface CliRequest {
  command: string;
  args?: Record<string, unknown>;
}

/** JSON response sent back to CLI client. */
interface CliResponse {
  ok: boolean;
  message: string;
}

/**
 * Named pipe / Unix socket server that runs in the main process.
 * Accepts JSON commands from CLI clients, dispatches them to the command registry,
 * and sends JSON responses back.
 */
export class CliServer {
  private server: net.Server | null = null;
  private readonly pipePath: string;

  constructor(isDev: boolean) {
    this.pipePath = getPipePath(isDev);
  }

  /**
   * Start listening on the named pipe / Unix socket.
   * On macOS/Linux, attempts to clean up stale socket files before binding.
   * Sets socket file permissions to 0o600 after binding on macOS/Linux.
   */
  async start(): Promise<void> {
    if (process.platform !== 'win32') {
      const shouldStart = await this.cleanupStaleSocket();
      if (!shouldStart) {
        return;
      }
    }

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.on('error', (err) => {
        log.error('[CliServer] Failed to start pipe server:', err);
        reject(err);
      });

      this.server!.listen(this.pipePath, () => {
        // Restrict Unix socket to owner-only access
        if (process.platform !== 'win32') {
          try {
            fs.chmodSync(this.pipePath, 0o600);
          } catch (chmodError) {
            log.warn('[CliServer] Failed to set socket file permissions:', chmodError);
          }
        }
        log.info(`[CliServer] Listening on ${this.pipePath}`);
        resolve();
      });
    });
  }

  /**
   * Stop the pipe server. Synchronous (calls server.close() without awaiting).
   */
  stop(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
      log.info('[CliServer] Stopped');
    }
  }

  /**
   * Handle an incoming client connection.
   * Reads newline-delimited JSON, dispatches command, sends response, closes socket.
   */
  private handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const messageText = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        this.processMessage(socket, messageText);
      }
    });

    socket.on('error', (err) => {
      log.debug('[CliServer] Socket error:', err);
    });
  }

  /**
   * Parse, dispatch, and respond to a single CLI message.
   */
  private async processMessage(socket: net.Socket, messageText: string): Promise<void> {
    let request: CliRequest;
    try {
      request = JSON.parse(messageText) as CliRequest;
    } catch {
      const errorResponse: CliResponse = { ok: false, message: 'Invalid request' };
      socket.write(JSON.stringify(errorResponse) + '\n');
      socket.end();
      return;
    }

    let response: CliResponse;
    try {
      response = await dispatchCommand(request.command);
    } catch (dispatchError) {
      log.error('[CliServer] Command dispatch error:', dispatchError);
      response = { ok: false, message: 'Internal server error' };
    }

    socket.write(JSON.stringify(response) + '\n');
    socket.end();
  }

  /**
   * On macOS/Linux: check for a stale socket file and remove it if safe.
   * - If no file exists: proceed normally (returns true).
   * - If connection is refused (ECONNREFUSED): stale file, delete and proceed (returns true).
   * - If connection succeeds: another instance is active, skip server start (returns false).
   * - Any other error: log warning, attempt to delete the file and proceed (returns true).
   *
   * @returns true if the server should proceed to bind, false if it should skip.
   */
  private cleanupStaleSocket(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        fs.accessSync(this.pipePath);
      } catch {
        // Socket file does not exist — proceed normally
        resolve(true);
        return;
      }

      // File exists — test whether another instance owns it
      const probeSocket = net.createConnection(this.pipePath);

      probeSocket.on('connect', () => {
        // Another instance is listening on this socket — leave it alone
        probeSocket.destroy();
        log.warn('[CliServer] Another active instance owns the socket. CLI server will not start on this path.');
        resolve(false);
      });

      probeSocket.on('error', (err: NodeJS.ErrnoException) => {
        probeSocket.destroy();
        if (err.code === 'ECONNREFUSED') {
          // Stale socket — safe to remove
          try {
            fs.unlinkSync(this.pipePath);
            log.info('[CliServer] Removed stale socket file');
          } catch (unlinkError) {
            log.warn('[CliServer] Failed to remove stale socket file:', unlinkError);
          }
        } else {
          log.warn(`[CliServer] Unexpected error testing socket (${err.code}):`, err);
          // Attempt cleanup anyway and proceed
          try {
            fs.unlinkSync(this.pipePath);
          } catch {
            // Ignore unlink failure
          }
        }
        resolve(true);
      });
    });
  }
}
