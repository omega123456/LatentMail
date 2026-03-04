/**
 * CLI client script — runs under ELECTRON_RUN_AS_NODE=1.
 *
 * CRITICAL IMPORT RESTRICTION: This file MUST ONLY import Node.js built-in modules,
 * pipe-path.ts, and cli-commands-meta.ts. Do NOT import Electron APIs, LoggerService,
 * DatabaseService, SyncQueueBridge, or any module that transitively depends on them.
 * Violating this constraint will crash the CLI process.
 */
import * as net from 'net';
import { getPipePath } from './pipe-path';
import { CLI_COMMANDS_META } from './cli-commands-meta';

/** Timeout covering the full round-trip: connect + response receipt. */
const TIMEOUT_MS = 5000;

/**
 * Whether to emit ANSI colour codes.
 *
 * Colour is enabled when:
 *   - stdout is a TTY, OR a known colour-capable terminal is detected
 *     (WT_SESSION = Windows Terminal, COLORTERM = most Linux/macOS terminals,
 *     FORCE_COLOR = explicit opt-in), AND
 *   - NO_COLOR is not set to a non-empty value (per https://no-color.org).
 *
 * The isTTY fallbacks are needed because Electron in ELECTRON_RUN_AS_NODE=1
 * mode does not always propagate isTTY even when attached to a real terminal.
 */
const hasColourTerminal: boolean = Boolean(
  process.stdout.isTTY ||
  process.env['FORCE_COLOR'] ||
  process.env['WT_SESSION'] ||    // Windows Terminal
  process.env['COLORTERM'],       // Most colour-capable terminals on Linux/macOS
);
const useColour: boolean = hasColourTerminal && !process.env['NO_COLOR'];

/** Wraps text in ANSI green when colour is enabled. */
function green(text: string): string {
  if (useColour) {
    return `\x1b[32m${text}\x1b[0m`;
  }
  return text;
}

/** Wraps text in ANSI red when colour is enabled. */
function red(text: string): string {
  if (useColour) {
    return `\x1b[31m${text}\x1b[0m`;
  }
  return text;
}

/** Wraps text in ANSI yellow when colour is enabled. */
function yellow(text: string): string {
  if (useColour) {
    return `\x1b[33m${text}\x1b[0m`;
  }
  return text;
}

/** Wraps text in ANSI bold when colour is enabled. */
function bold(text: string): string {
  if (useColour) {
    return `\x1b[1m${text}\x1b[0m`;
  }
  return text;
}

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

/**
 * Prints the list of available CLI commands to stdout.
 * This is a client-side operation — it never connects to the socket.
 */
function showList(): void {
  const maxNameLength = CLI_COMMANDS_META.reduce(
    (longestLength, meta) => Math.max(longestLength, meta.name.length),
    0,
  );
  const paddedWidth = maxNameLength + 2;

  process.stdout.write(bold(yellow('LatentMail CLI')) + '\n');
  process.stdout.write('\n');
  process.stdout.write(bold('Usage:') + ' latentmail-cli <command>\n');
  process.stdout.write('\n');
  process.stdout.write(bold('Available commands:') + '\n');
  process.stdout.write('\n');

  for (const meta of CLI_COMMANDS_META) {
    const paddedName = meta.name.padEnd(paddedWidth);
    process.stdout.write(green(paddedName) + meta.description + '\n');
  }

  process.stdout.write('\n');
}

function main(): void {
  const commandName = process.argv[2];

  if (!commandName) {
    showList();
    process.exit(0);
    return;
  }

  if (commandName === 'list') {
    showList();
    process.exit(0);
    return;
  }

  const knownCommandNames = CLI_COMMANDS_META.map((meta) => meta.name);
  const isKnownCommand = knownCommandNames.includes(commandName);

  if (!isKnownCommand) {
    process.stderr.write(red(`Unknown command: "${commandName}"`) + '\n');
    process.stderr.write("Run 'latentmail-cli list' to see available commands.\n");
    process.exit(1);
    return;
  }

  const isDev = process.env['LATENTMAIL_DEV'] === '1';
  const pipePath = getPipePath(isDev);

  const client = net.createConnection(pipePath);
  let responseReceived = false;

  const timeoutHandle = setTimeout(() => {
    if (!responseReceived) {
      process.stderr.write(red('Error: no response from LatentMail (timeout)') + '\n');
      client.destroy();
      process.exit(1);
    }
  }, TIMEOUT_MS);

  client.on('connect', () => {
    const request: CliRequest = { command: commandName, args: {} };
    client.write(JSON.stringify(request) + '\n');
  });

  let buffer = '';

  client.on('data', (chunkData) => {
    buffer += chunkData.toString();
    const newlineIndex = buffer.indexOf('\n');
    if (newlineIndex !== -1) {
      const messageText = buffer.slice(0, newlineIndex);
      responseReceived = true;
      clearTimeout(timeoutHandle);

      try {
        const response = JSON.parse(messageText) as CliResponse;
        if (response.ok) {
          process.stdout.write(green(response.message) + '\n');
        } else {
          process.stderr.write(red(response.message) + '\n');
        }
        client.destroy();
        process.exit(response.ok ? 0 : 1);
      } catch {
        process.stderr.write(red('Error: invalid response from LatentMail') + '\n');
        client.destroy();
        process.exit(1);
      }
    }
  });

  client.on('error', (err: NodeJS.ErrnoException) => {
    clearTimeout(timeoutHandle);
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
      process.stderr.write(red('LatentMail is not running') + '\n');
      process.exit(1);
    } else {
      process.stderr.write(red(`Error connecting to LatentMail: ${err.message}`) + '\n');
      process.exit(1);
    }
  });

  client.on('close', () => {
    if (!responseReceived) {
      clearTimeout(timeoutHandle);
      process.stderr.write(red('LatentMail is not running') + '\n');
      process.exit(1);
    }
  });
}

main();
