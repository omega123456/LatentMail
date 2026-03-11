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
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { callIpc, seedTestAccount } from '../infrastructure/test-helpers';
import { hiddenWindow } from '../test-main';

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
  });
});
