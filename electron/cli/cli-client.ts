/**
 * CLI client script — runs under ELECTRON_RUN_AS_NODE=1.
 *
 * CRITICAL IMPORT RESTRICTION: This file MUST ONLY import Node.js built-in modules
 * and pipe-path.ts. Do NOT import Electron APIs, LoggerService, DatabaseService,
 * SyncQueueBridge, or any module that transitively depends on them.
 * Violating this constraint will crash the CLI process.
 */
import * as net from 'net';
import { getPipePath } from './pipe-path';

/** Timeout covering the full round-trip: connect + response receipt. */
const TIMEOUT_MS = 5000;

/** JSON request payload sent to the server. */
interface CliRequest {
  command: string;
  args: Record<string, unknown>;
}

/** JSON response payload received from the server. */
interface CliResponse {
  ok: boolean;
  message: string;
}

function main(): void {
  const command = process.argv[2];

  if (!command) {
    process.stderr.write('Usage: latentmail-cli <command>\n');
    process.stderr.write('Available commands: pause-sync, resume-sync\n');
    process.exit(1);
    return;
  }

  const isDev = process.env['LATENTMAIL_DEV'] === '1';
  const pipePath = getPipePath(isDev);

  const client = net.createConnection(pipePath);
  let responseReceived = false;

  const timeoutHandle = setTimeout(() => {
    if (!responseReceived) {
      process.stderr.write('Error: no response from LatentMail (timeout)\n');
      client.destroy();
      process.exit(1);
    }
  }, TIMEOUT_MS);

  client.on('connect', () => {
    const request: CliRequest = { command, args: {} };
    client.write(JSON.stringify(request) + '\n');
  });

  let buffer = '';

  client.on('data', (chunk) => {
    buffer += chunk.toString();
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex !== -1) {
      const messageText = buffer.slice(0, newlineIndex);
      responseReceived = true;
      clearTimeout(timeoutHandle);

      try {
        const response = JSON.parse(messageText) as CliResponse;
        process.stdout.write(response.message + '\n');
        client.destroy();
        process.exit(response.ok ? 0 : 1);
      } catch {
        process.stderr.write('Error: invalid response from LatentMail\n');
        client.destroy();
        process.exit(1);
      }
    }
  });

  client.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(timeoutHandle);
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
      process.stdout.write('LatentMail is not running\n');
      process.exit(1);
    } else {
      process.stderr.write(`Error connecting to LatentMail: ${err.message}\n`);
      process.exit(1);
    }
  });

  client.on('close', () => {
    if (!responseReceived) {
      clearTimeout(timeoutHandle);
      process.stdout.write('LatentMail is not running\n');
      process.exit(1);
    }
  });
}

main();
