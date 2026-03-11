/**
 * cli-commands.test.ts — Backend E2E tests for the CLI server.
 *
 * Covers:
 *   - CLI server starts and listens on the named pipe / socket
 *   - pause-sync command pauses background sync (verified via SyncQueueBridge.isPaused())
 *   - resume-sync command resumes background sync
 *   - Idempotent commands: pause-sync when already paused, resume-sync when not paused
 *   - Unknown command returns a structured error with available commands list
 *   - Invalid JSON request returns an error response
 *   - Server cleanup: stop closes the server on all platforms and removes the
 *     Unix socket file where applicable
 *
 * Architecture:
 *   - The global test bootstrap does NOT start a CliServer. Each test in this
 *     suite manages its own CliServer instance.
 *   - CLI_PIPE_PATH env var is set to a test-specific path to avoid collisions
 *     with any running dev app (the pipe-path.ts module reads this env var).
 *   - Communication uses net.connect() to the test pipe, writes newline-delimited
 *     JSON, and reads the response.
 *
 * Note on SyncQueueBridge state:
 *   - quiesceAndRestore() calls SyncQueueBridge.suspendForTesting() which does NOT
 *     set the 'paused' flag. Then seedTestAccount() calls resumeForTesting() which
 *     clears testSuspended but does NOT start the bridge.
 *   - The 'paused' flag (SyncQueueBridge.isPaused()) is only controlled by
 *     pause() / resume() and is NOT affected by quiesceAndRestore().
 *   - CLI tests call pause() and resume() via the CLI server; they verify the
 *     isPaused() state directly.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { seedTestAccount } from '../infrastructure/test-helpers';

// ---- Type helpers ----

interface CliResponse {
  ok: boolean;
  message: string;
}

// -------------------------------------------------------------------------
// Helper: generate a test-specific pipe path
// -------------------------------------------------------------------------

function getTestPipePath(): string {
  // Use a unique-enough name so concurrent test runs don't collide.
  // The process PID + a static suffix is sufficient for sequential tests.
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\LatentMailTest-${process.pid}-cli`;
  } else {
    return path.join(os.tmpdir(), `latentmail-test-${process.pid}-cli.sock`);
  }
}

// -------------------------------------------------------------------------
// Helper: send a command to the CLI server and read the response
// -------------------------------------------------------------------------

function sendCliCommand(
  pipePath: string,
  requestObject: unknown,
  timeoutMs: number = 5_000,
): Promise<CliResponse> {
  return new Promise<CliResponse>((resolve, reject) => {
    const socket = net.createConnection(pipePath);

    const timeoutHandle = setTimeout(() => {
      socket.destroy();
      reject(new Error(`CLI command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    let buffer = '';

    socket.on('connect', () => {
      const payload = JSON.stringify(requestObject) + '\n';
      socket.write(payload);
    });

    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex !== -1) {
        const lineText = buffer.slice(0, newlineIndex);
        clearTimeout(timeoutHandle);
        try {
          const parsed = JSON.parse(lineText) as CliResponse;
          resolve(parsed);
        } catch {
          reject(new Error(`Failed to parse CLI response: ${lineText}`));
        }
        socket.destroy();
      }
    });

    socket.on('error', (socketError) => {
      clearTimeout(timeoutHandle);
      reject(socketError);
    });

    socket.on('close', () => {
      clearTimeout(timeoutHandle);
    });
  });
}

// =========================================================================
// CLI Server tests
// =========================================================================

describe('CLI Commands', () => {
  before(async function () {
    this.timeout(15_000);
    await quiesceAndRestore();
    seedTestAccount({ email: 'cli-test@example.com', displayName: 'CLI Test' });
  });

  // =========================================================================
  // Server lifecycle
  // =========================================================================

  describe('CliServer lifecycle — start and stop', () => {
    let testPipePath: string;

    before(() => {
      testPipePath = getTestPipePath();
      // Set the env var so CliServer uses our test path
      process.env['CLI_PIPE_PATH'] = testPipePath;
    });

    after(() => {
      // Clean up env var and socket file after tests
      delete process.env['CLI_PIPE_PATH'];
      if (process.platform !== 'win32' && fs.existsSync(testPipePath)) {
        try {
          fs.unlinkSync(testPipePath);
        } catch {
          // Ignore cleanup errors
        }
      }
    });

    it('CliServer starts and accepts connections on the test pipe path', async function () {
      this.timeout(10_000);

      const { CliServer } = require('../../../electron/cli/cli-server') as typeof import('../../../electron/cli/cli-server');
      const server = new CliServer(true);

      await server.start();

      // Verify the server is listening by sending a command and getting a response
      const response = await sendCliCommand(testPipePath, { command: 'resume-sync' });
      expect(response).to.have.property('ok');
      expect(response).to.have.property('message').that.is.a('string');

      await server.stop();
    });

    it('CliServer.stop() stops accepting new connections and removes the Unix socket file when applicable', async function () {
      this.timeout(10_000);

      // Use a fresh path for this test to avoid state from previous test
      const uniquePipePath = process.platform === 'win32'
        ? `\\\\.\\pipe\\LatentMailTest-${process.pid}-cli-stop`
        : path.join(os.tmpdir(), `latentmail-test-stop-${process.pid}.sock`);
      process.env['CLI_PIPE_PATH'] = uniquePipePath;

      const { CliServer } = require('../../../electron/cli/cli-server') as typeof import('../../../electron/cli/cli-server');
      const server = new CliServer(true);

      await server.start();

      if (process.platform !== 'win32') {
        const existsAfterStart = fs.existsSync(uniquePipePath);
        expect(existsAfterStart).to.equal(true);
      }

      await server.stop();

      if (process.platform !== 'win32') {
        const existsAfterStop = fs.existsSync(uniquePipePath);
        expect(existsAfterStop).to.equal(false);
      }

      // Verify the server is no longer accepting connections.
      const connectedAfterStop = await new Promise<boolean>((resolve) => {
        const probe = net.createConnection(uniquePipePath);
        probe.on('connect', () => {
          probe.destroy();
          resolve(true);
        });
        probe.on('error', () => {
          resolve(false);
        });
        setTimeout(() => {
          probe.destroy();
          resolve(false);
        }, 1000);
      });

      expect(connectedAfterStop).to.equal(false);

      // Clean up
      try {
        fs.unlinkSync(uniquePipePath);
      } catch {
        // Ignore
      }

      // Restore the original test pipe path
      process.env['CLI_PIPE_PATH'] = testPipePath;
    });
  });

  // =========================================================================
  // pause-sync command
  // =========================================================================

  describe('pause-sync command', () => {
    let testPipePath: string;
    let cliServer: InstanceType<typeof import('../../../electron/cli/cli-server').CliServer>;

    before(async function () {
      this.timeout(10_000);

      testPipePath = getTestPipePath() + '-pause';
      process.env['CLI_PIPE_PATH'] = testPipePath;

      const { CliServer } = require('../../../electron/cli/cli-server') as typeof import('../../../electron/cli/cli-server');
      cliServer = new CliServer(true);
      await cliServer.start();

      // Make sure sync is not paused before tests
      const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
      const bridge = SyncQueueBridge.getInstance();
      if (bridge.isPaused()) {
        bridge.resume();
      }
    });

    after(async () => {
      await cliServer.stop();
      delete process.env['CLI_PIPE_PATH'];
      if (process.platform !== 'win32' && fs.existsSync(testPipePath)) {
        try {
          fs.unlinkSync(testPipePath);
        } catch {
          // Ignore
        }
      }
      // Ensure sync is resumed after tests
      try {
        const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
        const bridge = SyncQueueBridge.getInstance();
        if (bridge.isPaused()) {
          bridge.resume();
        }
      } catch {
        // Non-fatal
      }
    });

    it('pause-sync returns ok=true and pauses background sync', async function () {
      this.timeout(10_000);

      const response = await sendCliCommand(testPipePath, { command: 'pause-sync' });

      expect(response.ok).to.equal(true);
      expect(response.message).to.be.a('string');

      // Verify the sync bridge is paused
      const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
      const isPaused = SyncQueueBridge.getInstance().isPaused();
      expect(isPaused).to.equal(true);
    });

    it('pause-sync when already paused returns ok=true with idempotent message', async function () {
      this.timeout(10_000);

      // Sync is already paused from the previous test
      const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
      expect(SyncQueueBridge.getInstance().isPaused()).to.equal(true);

      const response = await sendCliCommand(testPipePath, { command: 'pause-sync' });

      // Should still succeed (idempotent)
      expect(response.ok).to.equal(true);
      expect(response.message).to.be.a('string');
      // Message should indicate it was already paused
      expect(response.message.toLowerCase()).to.include('already paused');
    });
  });

  // =========================================================================
  // resume-sync command
  // =========================================================================

  describe('resume-sync command', () => {
    let testPipePath: string;
    let cliServer: InstanceType<typeof import('../../../electron/cli/cli-server').CliServer>;

    before(async function () {
      this.timeout(10_000);

      testPipePath = getTestPipePath() + '-resume';
      process.env['CLI_PIPE_PATH'] = testPipePath;

      const { CliServer } = require('../../../electron/cli/cli-server') as typeof import('../../../electron/cli/cli-server');
      cliServer = new CliServer(true);
      await cliServer.start();

      // Pause first so we can test resume
      const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
      const bridge = SyncQueueBridge.getInstance();
      if (!bridge.isPaused()) {
        await bridge.pause();
      }
    });

    after(async () => {
      await cliServer.stop();
      delete process.env['CLI_PIPE_PATH'];
      if (process.platform !== 'win32' && fs.existsSync(testPipePath)) {
        try {
          fs.unlinkSync(testPipePath);
        } catch {
          // Ignore
        }
      }
      // Ensure sync is not paused after this suite
      try {
        const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
        const bridge = SyncQueueBridge.getInstance();
        if (bridge.isPaused()) {
          bridge.resume();
        }
      } catch {
        // Non-fatal
      }
    });

    it('resume-sync returns ok=true and resumes background sync', async function () {
      this.timeout(10_000);

      // Verify it's paused before resuming
      const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
      expect(SyncQueueBridge.getInstance().isPaused()).to.equal(true);

      const response = await sendCliCommand(testPipePath, { command: 'resume-sync' });

      expect(response.ok).to.equal(true);
      expect(response.message).to.be.a('string');

      // Verify sync is no longer paused
      const isPaused = SyncQueueBridge.getInstance().isPaused();
      expect(isPaused).to.equal(false);
    });

    it('resume-sync when not paused returns ok=true with idempotent message', async function () {
      this.timeout(10_000);

      // Sync is not paused from the previous test
      const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
      expect(SyncQueueBridge.getInstance().isPaused()).to.equal(false);

      const response = await sendCliCommand(testPipePath, { command: 'resume-sync' });

      expect(response.ok).to.equal(true);
      expect(response.message).to.be.a('string');
      // Message should indicate sync is not paused
      expect(response.message.toLowerCase()).to.include('not paused');
    });
  });

  // =========================================================================
  // Unknown command
  // =========================================================================

  describe('Unknown command — returns structured error', () => {
    let testPipePath: string;
    let cliServer: InstanceType<typeof import('../../../electron/cli/cli-server').CliServer>;

    before(async function () {
      this.timeout(10_000);

      testPipePath = getTestPipePath() + '-unknown';
      process.env['CLI_PIPE_PATH'] = testPipePath;

      const { CliServer } = require('../../../electron/cli/cli-server') as typeof import('../../../electron/cli/cli-server');
      cliServer = new CliServer(true);
      await cliServer.start();
    });

    after(async () => {
      await cliServer.stop();
      delete process.env['CLI_PIPE_PATH'];
      if (process.platform !== 'win32' && fs.existsSync(testPipePath)) {
        try {
          fs.unlinkSync(testPipePath);
        } catch {
          // Ignore
        }
      }
    });

    it('an unknown command returns ok=false with the available commands listed', async function () {
      this.timeout(10_000);

      const response = await sendCliCommand(testPipePath, { command: 'nonexistent-command-xyz' });

      expect(response.ok).to.equal(false);
      expect(response.message).to.be.a('string');
      // The error message should mention the unknown command
      expect(response.message).to.include('nonexistent-command-xyz');
      // The available commands should be listed in the message
      expect(response.message.toLowerCase()).to.include('available commands');
      // Known commands should be listed
      expect(response.message).to.include('pause-sync');
      expect(response.message).to.include('resume-sync');
    });

    it('an empty string command returns ok=false', async function () {
      this.timeout(10_000);

      const response = await sendCliCommand(testPipePath, { command: '' });

      expect(response.ok).to.equal(false);
      expect(response.message).to.be.a('string');
    });
  });

  // =========================================================================
  // Invalid JSON request
  // =========================================================================

  describe('Invalid JSON request — returns error response', () => {
    let testPipePath: string;
    let cliServer: InstanceType<typeof import('../../../electron/cli/cli-server').CliServer>;

    before(async function () {
      this.timeout(10_000);

      testPipePath = getTestPipePath() + '-invalid';
      process.env['CLI_PIPE_PATH'] = testPipePath;

      const { CliServer } = require('../../../electron/cli/cli-server') as typeof import('../../../electron/cli/cli-server');
      cliServer = new CliServer(true);
      await cliServer.start();
    });

    after(async () => {
      await cliServer.stop();
      delete process.env['CLI_PIPE_PATH'];
      if (process.platform !== 'win32' && fs.existsSync(testPipePath)) {
        try {
          fs.unlinkSync(testPipePath);
        } catch {
          // Ignore
        }
      }
    });

    it('malformed JSON returns ok=false with invalid request message', function (done) {
      this.timeout(10_000);

      const socket = net.createConnection(testPipePath);

      const timeoutHandle = setTimeout(() => {
        socket.destroy();
        done(new Error('Timed out waiting for CLI server response to invalid JSON'));
      }, 5_000);

      let buffer = '';

      socket.on('connect', () => {
        // Send malformed JSON (missing closing brace)
        socket.write('{"command": "pause-sync"\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex !== -1) {
          const lineText = buffer.slice(0, newlineIndex);
          clearTimeout(timeoutHandle);
          try {
            const parsed = JSON.parse(lineText) as CliResponse;
            expect(parsed.ok).to.equal(false);
            expect(parsed.message.toLowerCase()).to.include('invalid');
            done();
          } catch (assertError) {
            done(assertError);
          }
          socket.destroy();
        }
      });

      socket.on('error', (socketError) => {
        clearTimeout(timeoutHandle);
        done(socketError);
      });
    });

    it('plain text (non-JSON) returns ok=false with invalid request message', function (done) {
      this.timeout(10_000);

      const socket = net.createConnection(testPipePath);

      const timeoutHandle = setTimeout(() => {
        socket.destroy();
        done(new Error('Timed out waiting for CLI server response to plain text'));
      }, 5_000);

      let buffer = '';

      socket.on('connect', () => {
        // Send plain text instead of JSON
        socket.write('pause-sync\n');
      });

      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        const newlineIndex = buffer.indexOf('\n');
        if (newlineIndex !== -1) {
          const lineText = buffer.slice(0, newlineIndex);
          clearTimeout(timeoutHandle);
          try {
            const parsed = JSON.parse(lineText) as CliResponse;
            expect(parsed.ok).to.equal(false);
            expect(parsed.message).to.be.a('string');
            done();
          } catch (assertError) {
            done(assertError);
          }
          socket.destroy();
        }
      });

      socket.on('error', (socketError) => {
        clearTimeout(timeoutHandle);
        done(socketError);
      });
    });
  });

  // =========================================================================
  // Multiple sequential requests on the same server
  // =========================================================================

  describe('Multiple sequential requests', () => {
    let testPipePath: string;
    let cliServer: InstanceType<typeof import('../../../electron/cli/cli-server').CliServer>;

    before(async function () {
      this.timeout(10_000);

      testPipePath = getTestPipePath() + '-multi';
      process.env['CLI_PIPE_PATH'] = testPipePath;

      const { CliServer } = require('../../../electron/cli/cli-server') as typeof import('../../../electron/cli/cli-server');
      cliServer = new CliServer(true);
      await cliServer.start();

      // Ensure sync is not paused
      const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
      const bridge = SyncQueueBridge.getInstance();
      if (bridge.isPaused()) {
        bridge.resume();
      }
    });

    after(async () => {
      await cliServer.stop();
      delete process.env['CLI_PIPE_PATH'];
      if (process.platform !== 'win32' && fs.existsSync(testPipePath)) {
        try {
          fs.unlinkSync(testPipePath);
        } catch {
          // Ignore
        }
      }
      // Ensure sync is not paused after this suite
      try {
        const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
        const bridge = SyncQueueBridge.getInstance();
        if (bridge.isPaused()) {
          bridge.resume();
        }
      } catch {
        // Non-fatal
      }
    });

    it('can send pause-sync then resume-sync in sequence', async function () {
      this.timeout(15_000);

      // Each CLI request opens a new connection (the server handles one request per connection)
      const pauseResponse = await sendCliCommand(testPipePath, { command: 'pause-sync' });
      expect(pauseResponse.ok).to.equal(true);

      const { SyncQueueBridge } = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
      expect(SyncQueueBridge.getInstance().isPaused()).to.equal(true);

      const resumeResponse = await sendCliCommand(testPipePath, { command: 'resume-sync' });
      expect(resumeResponse.ok).to.equal(true);

      expect(SyncQueueBridge.getInstance().isPaused()).to.equal(false);
    });

    it('handles an unknown command interspersed with valid commands', async function () {
      this.timeout(15_000);

      const unknownResponse = await sendCliCommand(testPipePath, { command: 'list-mails-xyz' });
      expect(unknownResponse.ok).to.equal(false);

      // Server should still handle subsequent valid commands
      const pauseResponse = await sendCliCommand(testPipePath, { command: 'pause-sync' });
      expect(pauseResponse.ok).to.equal(true);

      const resumeResponse = await sendCliCommand(testPipePath, { command: 'resume-sync' });
      expect(resumeResponse.ok).to.equal(true);
    });
  });
});
