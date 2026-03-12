/**
 * system-os.test.ts — Backend E2E tests for system/OS IPC handlers.
 *
 * Covers:
 *   - Window controls via hidden window: system:minimize, system:maximize, system:is-maximized
 *   - system:close — stubs hidden window's close() method with a spy, verifies spy was called,
 *     then restores the original method (avoids actually closing the test window)
 *   - system:get-platform returns the current process platform
 *   - system:get-is-mac-os returns a boolean
 *   - Zoom: system:set-zoom clamps to [0.75, 1.5]; system:get-zoom returns applied value
 *   - Logger: logger:get-recent-entries returns an array of log entry objects
 *   - Window state persistence via windowState setting (DB round-trip only)
 *   - sync:pause / sync:resume / sync:get-paused IPC round-trip
 *
 * Out of scope:
 *   - TrayService (requires OS tray — deferred to Playwright)
 *   - NativeDropService (requires Win32 addon + real window)
 *   - Desktop notifications (verified via events in sync suite)
 *   - openAtLogin OS mutation (verified via DB only in database-settings suite)
 *
 * Window Note:
 *   The hidden BrowserWindow from test-main.ts serves as the target for all
 *   window control tests. This suite does NOT create any additional windows.
 */

import { BrowserWindow } from 'electron';
import { expect } from 'chai';
import * as fs from 'fs';
import * as path from 'path';
import { DateTime } from 'luxon';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { callIpc, seedTestAccount } from '../infrastructure/test-helpers';
import { hiddenWindow } from '../test-main';
import { LoggerService } from '../../../electron/services/logger-service';
import { getLastIpcActivityTimestamp } from '../../../electron/ipc/ipc-activity-tracker';
import { SyncQueueBridge } from '../../../electron/services/sync-queue-bridge';

// ---- Type helpers ----

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// =========================================================================
// System tests
// =========================================================================

describe('System & OS', () => {
  before(async function () {
    this.timeout(15_000);
    await quiesceAndRestore();
    seedTestAccount({ email: 'system-test@example.com', displayName: 'System Test' });
  });

  // =========================================================================
  // Window controls
  // =========================================================================

  describe('Window controls — system:minimize / system:maximize / system:is-maximized', () => {
    it('system:minimize does not throw', async () => {
      // Minimize may be a no-op on headless but the IPC should not error
      const result = await callIpc('system:minimize');
      // system:minimize handler returns undefined (no explicit return)
      expect(result).to.be.oneOf([undefined, null]);
    });

    it('system:is-maximized returns a boolean', async () => {
      const result = await callIpc('system:is-maximized');
      expect(result).to.be.a('boolean');
    });

    it('system:maximize does not throw', async () => {
      // Maximize / unmaximize on a headless window is a no-op but must not error
      const result = await callIpc('system:maximize');
      expect(result).to.be.oneOf([undefined, null]);
    });

    it('system:maximize toggles through the unmaximize branch when the window reports maximized', async () => {
      const window = hiddenWindow as BrowserWindow & {
        isMaximized: () => boolean;
        unmaximize: () => void;
      };

      const originalIsMaximized = window.isMaximized.bind(window);
      const originalUnmaximize = window.unmaximize.bind(window);
      let unmaximizeCalled = false;

      window.isMaximized = (): boolean => {
        return true;
      };
      window.unmaximize = (): void => {
        unmaximizeCalled = true;
      };

      try {
        const result = await callIpc('system:maximize');
        expect(result).to.be.oneOf([undefined, null]);
        expect(unmaximizeCalled).to.equal(true);
      } finally {
        window.isMaximized = originalIsMaximized;
        window.unmaximize = originalUnmaximize;
      }
    });
  });

  describe('system:close — spy prevents actual close', () => {
    it('system:close dispatches to the hidden window close() method', async () => {
      // We must not actually close the hidden window (it would end the test process).
      // Stub the close() method with a spy, invoke the IPC, verify the spy was called,
      // then restore the original close() before the test ends.
      const window = hiddenWindow;
      expect(window).to.not.be.null;

      const originalClose = window!.close.bind(window);
      let closeCalled = false;

      // Replace close() with a spy
      (window as unknown as Record<string, unknown>)['close'] = (): void => {
        closeCalled = true;
        // DO NOT call originalClose — we must keep the window alive
      };

      try {
        await callIpc('system:close');
        expect(closeCalled).to.equal(true);
      } finally {
        // Always restore to prevent the test suite from breaking subsequent tests
        (window as unknown as Record<string, unknown>)['close'] = originalClose;
      }
    });
  });

  // =========================================================================
  // Platform detection
  // =========================================================================

  describe('Platform detection — system:get-platform / system:get-is-mac-os', () => {
    it('system:get-platform returns a non-empty string matching process.platform', async () => {
      const result = await callIpc('system:get-platform');

      expect(result).to.be.a('string');
      expect(result).to.equal(process.platform);
    });

    it('system:get-is-mac-os returns a boolean matching process.platform darwin', async () => {
      const result = await callIpc('system:get-is-mac-os');

      expect(result).to.be.a('boolean');
      const expectedIsMac = process.platform === 'darwin';
      expect(result).to.equal(expectedIsMac);
    });
  });

  // =========================================================================
  // Zoom level
  // =========================================================================

  describe('Zoom level — system:set-zoom / system:get-zoom', () => {
    it('system:set-zoom returns the applied (clamped) zoom factor', async () => {
      const result = await callIpc('system:set-zoom', 1.25);

      expect(result).to.be.a('number');
      expect(result).to.be.closeTo(1.25, 0.01);
    });

    it('system:set-zoom clamps values below 0.75 to 0.75', async () => {
      const result = await callIpc('system:set-zoom', 0.1);

      expect(result).to.be.a('number');
      expect(result).to.be.closeTo(0.75, 0.01);
    });

    it('system:set-zoom clamps values above 1.5 to 1.5', async () => {
      const result = await callIpc('system:set-zoom', 9.9);

      expect(result).to.be.a('number');
      expect(result).to.be.closeTo(1.5, 0.01);
    });

    it('system:set-zoom treats NaN as 1.0 and clamps to valid range', async () => {
      // The handler converts NaN to 1.0 then clamps to [0.75, 1.5]
      const result = await callIpc('system:set-zoom', NaN);

      expect(result).to.be.a('number');
      // 1.0 is within [0.75, 1.5] so it should return 1.0
      expect(result).to.be.closeTo(1.0, 0.01);
    });

    it('system:get-zoom returns the currently set zoom factor', async () => {
      // Set a specific zoom first
      await callIpc('system:set-zoom', 1.1);

      const result = await callIpc('system:get-zoom');

      expect(result).to.be.a('number');
      // Zoom should be near 1.1 (may vary slightly due to float precision)
      expect(result as number).to.be.closeTo(1.1, 0.05);
    });

    it('system:set-zoom returns 1.0 when given a non-number string', async () => {
      // The handler has: typeof factor === 'number' && !isNaN(factor) ? factor : 1.0
      // Passing a string from the renderer should fall back to 1.0
      const result = await callIpc('system:set-zoom', 'not-a-number');

      expect(result).to.be.a('number');
      expect(result).to.be.closeTo(1.0, 0.01);
    });
  });

  // =========================================================================
  // Logger entries
  // =========================================================================

  describe('logger:get-recent-entries', () => {
    it('returns an array (possibly empty) of log entry objects', async () => {
      const response = await callIpc('logger:get-recent-entries') as IpcResponse<{
        entries: Array<{ date: string; level: string; message: string }>;
      }>;

      expect(response.success).to.equal(true);
      expect(response.data!.entries).to.be.an('array');
    });

    it('log entries have date, level, and message fields when present', async () => {
      const response = await callIpc('logger:get-recent-entries') as IpcResponse<{
        entries: Array<{ date: string; level: string; message: string }>;
      }>;

      expect(response.success).to.equal(true);
      const entries = response.data!.entries;

      if (entries.length > 0) {
        const firstEntry = entries[0];
        expect(firstEntry).to.have.property('date').that.is.a('string');
        expect(firstEntry).to.have.property('level').that.is.a('string');
        expect(firstEntry).to.have.property('message').that.is.a('string');
        // Level should be one of the known log levels
        expect(['debug', 'info', 'warn', 'error']).to.include(firstEntry.level.toLowerCase());
      }
    });

    it('returns recently written log entries as an array', async function () {
      this.timeout(10_000);

      const logger = LoggerService.getInstance() as unknown as {
        info: (...args: unknown[]) => void;
        getLogDir: () => string;
      };
      const marker = 'logger-suite-recent-entry-marker';
      const logDir = logger.getLogDir();
      fs.mkdirSync(logDir, { recursive: true });
      const todayDate = DateTime.now().toISODate() ?? '2026-03-12';
      const todayLogPath = path.join(logDir, `main-${todayDate}.log`);
      logger.info(marker);
      fs.writeFileSync(
        todayLogPath,
        `[${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss.SSS')}] [info] ${marker}\n`,
      );

      const response = await callIpc('logger:get-recent-entries') as IpcResponse<{
        entries: Array<{ date: string; level: string; message: string }>;
      }>;

      expect(response.success).to.equal(true);
      expect(response.data!.entries).to.be.an('array');
      const matchingEntry = response.data!.entries.find((entry) => entry.message.includes(marker));
      expect(matchingEntry).to.exist;
      expect(matchingEntry!.level).to.equal('info');
    });

    it('returns an empty array when the current log file is empty', async function () {
      this.timeout(10_000);

      const logger = LoggerService.getInstance() as unknown as {
        getLogDir: () => string;
      };
      const originalGetLogDir = logger.getLogDir;
      const emptyLogDir = path.join(__dirname, '..', '.tmp-empty-logs');
      fs.rmSync(emptyLogDir, { recursive: true, force: true });
      fs.mkdirSync(emptyLogDir, { recursive: true });

      logger.getLogDir = () => emptyLogDir;

      try {
        const todayDate = DateTime.now().toISODate() ?? '2026-03-12';
        const todayLogPath = path.join(emptyLogDir, `main-${todayDate}.log`);
        fs.writeFileSync(todayLogPath, '');

        const response = await callIpc('logger:get-recent-entries') as IpcResponse<{
          entries: Array<{ date: string; level: string; message: string }>;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.entries).to.deep.equal([]);
      } finally {
        logger.getLogDir = originalGetLogDir;
        fs.rmSync(emptyLogDir, { recursive: true, force: true });
      }
    });

    it('returns multiline log entries as part of the previous message', async function () {
      this.timeout(10_000);

      const logger = LoggerService.getInstance() as unknown as {
        getLogDir: () => string;
      };
      const originalGetLogDir = logger.getLogDir;
      const multilineLogDir = path.join(__dirname, '..', '.tmp-multiline-logs');
      fs.rmSync(multilineLogDir, { recursive: true, force: true });
      fs.mkdirSync(multilineLogDir, { recursive: true });
      logger.getLogDir = () => multilineLogDir;

      try {
        const todayDate = DateTime.now().toISODate() ?? '2026-03-12';
        const todayLogPath = path.join(multilineLogDir, `main-${todayDate}.log`);
        fs.writeFileSync(
          todayLogPath,
          [
            `[${DateTime.now().toFormat('yyyy-MM-dd HH:mm:ss.SSS')}] [error] First line`,
            'Second line of stack trace',
            'Third line of stack trace',
            '',
          ].join('\n'),
        );

        const response = await callIpc('logger:get-recent-entries') as IpcResponse<{
          entries: Array<{ date: string; level: string; message: string }>;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.entries).to.have.lengthOf(1);
        expect(response.data!.entries[0].message).to.include('First line');
        expect(response.data!.entries[0].message).to.include('Second line of stack trace');
      } finally {
        logger.getLogDir = originalGetLogDir;
        fs.rmSync(multilineLogDir, { recursive: true, force: true });
      }
    });

    it('returns LOGGER_READ_FAILED when reading recent log entries throws unexpectedly', async () => {
      const logger = LoggerService.getInstance() as unknown as {
        getRecentEntries: (limit: number) => Promise<Array<{ date: string; level: string; message: string }>>;
      };
      const originalGetRecentEntries = logger.getRecentEntries;
      logger.getRecentEntries = async (_limit: number): Promise<Array<{ date: string; level: string; message: string }>> => {
        throw new Error('forced logger IPC failure');
      };

      try {
        const response = await callIpc('logger:get-recent-entries') as IpcResponse<{
          entries: Array<{ date: string; level: string; message: string }>;
        }>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('LOGGER_READ_FAILED');
      } finally {
        logger.getRecentEntries = originalGetRecentEntries;
      }
    });

    it('returns entries from yesterday when today has no matching lines', async function () {
      this.timeout(10_000);

      const logger = LoggerService.getInstance() as unknown as {
        getLogDir: () => string;
      };
      const originalGetLogDir = logger.getLogDir;
      const tempLogDir = path.join(__dirname, '..', '.tmp-yesterday-logs');
      fs.rmSync(tempLogDir, { recursive: true, force: true });
      fs.mkdirSync(tempLogDir, { recursive: true });
      logger.getLogDir = () => tempLogDir;

      try {
        const todayDate = DateTime.now().toISODate() ?? '2026-03-12';
        const yesterdayDate = DateTime.now().minus({ days: 1 }).toISODate() ?? '2026-03-11';
        fs.writeFileSync(path.join(tempLogDir, `main-${todayDate}.log`), '');
        fs.writeFileSync(
          path.join(tempLogDir, `main-${yesterdayDate}.log`),
          `[${DateTime.now().minus({ days: 1 }).toFormat('yyyy-MM-dd HH:mm:ss.SSS')}] [warn] yesterday-only-marker\n`,
        );

        const response = await callIpc('logger:get-recent-entries') as IpcResponse<{
          entries: Array<{ date: string; level: string; message: string }>;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.entries.some((entry) => entry.message.includes('yesterday-only-marker'))).to.equal(true);
      } finally {
        logger.getLogDir = originalGetLogDir;
        fs.rmSync(tempLogDir, { recursive: true, force: true });
      }
    });

    it('returns an empty array when the log directory does not exist', async () => {
      const logger = LoggerService.getInstance() as unknown as {
        getLogDir: () => string;
      };
      const originalGetLogDir = logger.getLogDir;
      logger.getLogDir = () => path.join(__dirname, '..', '.tmp-missing-logs');

      try {
        const response = await callIpc('logger:get-recent-entries') as IpcResponse<{
          entries: Array<{ date: string; level: string; message: string }>;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.entries).to.deep.equal([]);
      } finally {
        logger.getLogDir = originalGetLogDir;
      }
    });
  });

  // =========================================================================
  // Window state persistence (DB round-trip)
  // =========================================================================

  describe('Window state persistence — db:set-settings / db:get-settings', () => {
    it('persists windowState setting to DB and reads it back', async () => {
      const testState = JSON.stringify({ x: 100, y: 200, width: 1024, height: 768 });

      const setResponse = await callIpc('db:set-settings', { windowState: testState }) as IpcResponse<null>;
      expect(setResponse.success).to.equal(true);

      const getResponse = await callIpc('db:get-settings', ['windowState']) as IpcResponse<Record<string, string | null>>;
      expect(getResponse.success).to.equal(true);
      expect(getResponse.data!['windowState']).to.equal(testState);
    });

    it('windowState can be updated and new value replaces old', async () => {
      const firstState = JSON.stringify({ x: 0, y: 0, width: 800, height: 600 });
      const secondState = JSON.stringify({ x: 50, y: 50, width: 1280, height: 720 });

      await callIpc('db:set-settings', { windowState: firstState });
      await callIpc('db:set-settings', { windowState: secondState });

      const getResponse = await callIpc('db:get-settings', ['windowState']) as IpcResponse<Record<string, string | null>>;
      expect(getResponse.success).to.equal(true);
      expect(getResponse.data!['windowState']).to.equal(secondState);
    });
  });

  // =========================================================================
  // Sync pause/resume IPC round-trip
  // =========================================================================

  describe('sync:pause / sync:resume / sync:get-paused', () => {
    it('sync:get-paused returns a boolean initially', async () => {
      const response = await callIpc('sync:get-paused') as IpcResponse<{ paused: boolean }>;

      expect(response.success).to.equal(true);
      expect(response.data!.paused).to.be.a('boolean');
    });

    it('sync:pause sets paused state to true', async () => {
      const pauseResponse = await callIpc('sync:pause') as IpcResponse<{ paused: boolean }>;
      expect(pauseResponse.success).to.equal(true);

      const stateResponse = await callIpc('sync:get-paused') as IpcResponse<{ paused: boolean }>;
      expect(stateResponse.success).to.equal(true);
      expect(stateResponse.data!.paused).to.equal(true);
    });

    it('sync:resume sets paused state to false', async () => {
      // First ensure it's paused
      await callIpc('sync:pause');

      const resumeResponse = await callIpc('sync:resume') as IpcResponse<{ paused: boolean }>;
      expect(resumeResponse.success).to.equal(true);

      const stateResponse = await callIpc('sync:get-paused') as IpcResponse<{ paused: boolean }>;
      expect(stateResponse.success).to.equal(true);
      expect(stateResponse.data!.paused).to.equal(false);
    });

    it('pause → get-paused → resume → get-paused round-trip is consistent', async () => {
      // pause
      await callIpc('sync:pause');
      const pausedState = await callIpc('sync:get-paused') as IpcResponse<{ paused: boolean }>;
      expect(pausedState.data!.paused).to.equal(true);

      // resume
      await callIpc('sync:resume');
      const resumedState = await callIpc('sync:get-paused') as IpcResponse<{ paused: boolean }>;
      expect(resumedState.data!.paused).to.equal(false);
    });

    it('sync:resume clears a sleep-stopped state via startAfterWake branch', async () => {
      const bridge = SyncQueueBridge.getInstance();
      bridge.stopForSleep();

      const pausedBeforeResume = await callIpc('sync:get-paused') as IpcResponse<{ paused: boolean }>;
      expect(pausedBeforeResume.success).to.equal(true);
      expect(pausedBeforeResume.data!.paused).to.equal(true);

      const resumeResponse = await callIpc('sync:resume') as IpcResponse<{ paused: boolean }>;
      expect(resumeResponse.success).to.equal(true);
      expect(resumeResponse.data!.paused).to.equal(false);

      const pausedAfterResume = await callIpc('sync:get-paused') as IpcResponse<{ paused: boolean }>;
      expect(pausedAfterResume.success).to.equal(true);
      expect(pausedAfterResume.data!.paused).to.equal(false);
    });

    it('rapid successive mail IPC calls monotonically update the tracked activity timestamp', async function () {
      this.timeout(10_000);

      const firstBefore = getLastIpcActivityTimestamp();
      const executeTrackedInvoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
        return hiddenWindow!.webContents.executeJavaScript(
          `window.electronTestAPI.invoke(${JSON.stringify(channel)}, ...${JSON.stringify(args)})`,
          true,
        );
      };

      const firstResponse = await executeTrackedInvoke('mail:get-folders', '1') as IpcResponse<unknown[]>;
      expect(firstResponse.success).to.equal(true);

      const firstAfter = getLastIpcActivityTimestamp();
      expect(firstAfter).to.be.greaterThan(firstBefore);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });

      const secondResponse = await executeTrackedInvoke('mail:fetch-emails', '1', 'INBOX', { limit: 10, offset: 0 }) as IpcResponse<unknown[]>;
      expect(secondResponse.success).to.equal(true);

      const secondAfter = getLastIpcActivityTimestamp();
      expect(secondAfter).to.be.at.least(firstAfter);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 5);
      });

      const thirdResponse = await executeTrackedInvoke('mail:get-folders', '1') as IpcResponse<unknown[]>;
      expect(thirdResponse.success).to.equal(true);

      const thirdAfter = getLastIpcActivityTimestamp();
      expect(thirdAfter).to.be.at.least(secondAfter);
    });
  });
});
