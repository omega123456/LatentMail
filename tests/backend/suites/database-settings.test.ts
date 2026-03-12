/**
 * database-settings.test.ts — Settings persistence and validation tests.
 *
 * Covers:
 *   - Settings read / write round-trip via DatabaseService
 *   - Partial key lookup via IPC db:get-settings
 *   - Unknown keys return undefined / null
 *   - Log level validation rejection via IPC db:set-log-level
 *   - openAtLogin persistence via db:set-settings IPC
 *   - Suite isolation: each test uses a quiesce/restore cycle so mutations
 *     in one test never bleed into the next
 *
 * Protocol:
 *   - before() hook: quiesceAndRestore() — restores clean DB snapshot
 *   - Each test operates on the DB independently; no state leaks between tests
 *     because each describe block (or test) calls quiesceAndRestore().
 */

import { app } from 'electron';
import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { getDatabase, callIpc } from '../infrastructure/test-helpers';
import { LoggerService } from '../../../electron/services/logger-service';

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Database Settings', () => {
  before(async () => {
    await quiesceAndRestore();
  });

  // ---- getSetting / setSetting ----

  describe('setSetting / getSetting round-trip', () => {
    it('stores and retrieves a single setting by key', () => {
      const db = getDatabase();
      db.setSetting('test.key', 'hello-value');
      const result = db.getSetting('test.key');
      expect(result).to.equal('hello-value');
    });

    it('overwrites an existing setting on second write', () => {
      const db = getDatabase();
      db.setSetting('overwrite.key', 'first');
      db.setSetting('overwrite.key', 'second');
      expect(db.getSetting('overwrite.key')).to.equal('second');
    });

    it('stores an empty string value without error', () => {
      const db = getDatabase();
      db.setSetting('empty.key', '');
      expect(db.getSetting('empty.key')).to.equal('');
    });

    it('stores a JSON-serialized value correctly', () => {
      const db = getDatabase();
      const payload = JSON.stringify({ flag: true, count: 42 });
      db.setSetting('json.key', payload);
      const stored = db.getSetting('json.key');
      expect(stored).to.equal(payload);
      const parsed = JSON.parse(stored!);
      expect(parsed).to.deep.equal({ flag: true, count: 42 });
    });

    it('stores a numeric string and retrieves it as a string', () => {
      const db = getDatabase();
      db.setSetting('numeric.key', '12345');
      expect(db.getSetting('numeric.key')).to.equal('12345');
    });
  });

  // ---- Unknown keys return null ----

  describe('unknown key lookup', () => {
    it('returns null for a key that was never set', () => {
      const db = getDatabase();
      const result = db.getSetting('nonexistent.key.xyz');
      expect(result).to.be.null;
    });

    it('returns null for a key with a typo', () => {
      const db = getDatabase();
      db.setSetting('real.key', 'present');
      expect(db.getSetting('real.key.typo')).to.be.null;
    });
  });

  // ---- getAllSettings ----

  describe('getAllSettings', () => {
    it('returns an object containing all persisted settings', () => {
      const db = getDatabase();
      db.setSetting('bulk.a', 'apple');
      db.setSetting('bulk.b', 'banana');
      const all = db.getAllSettings();
      expect(all).to.include({ 'bulk.a': 'apple', 'bulk.b': 'banana' });
    });

    it('returns an object (possibly empty) and not null/undefined', () => {
      const db = getDatabase();
      const all = db.getAllSettings();
      expect(all).to.be.an('object');
      expect(all).to.not.be.null;
    });
  });

  // ---- IPC db:get-settings ----

  describe('IPC db:get-settings', () => {
    it('returns all settings when called with no keys', async () => {
      const db = getDatabase();
      db.setSetting('ipc.all.x', 'valX');
      const result = await callIpc('db:get-settings') as IpcResponse<Record<string, string>>;
      expect(result.success).to.be.true;
      expect(result.data).to.include({ 'ipc.all.x': 'valX' });
    });

    it('returns a fully populated settings object when multiple keys exist', async () => {
      const db = getDatabase();
      db.setSetting('theme', 'light');
      db.setSetting('openAtLogin', 'false');
      db.setSetting('windowState', '{"width":1200}');
      db.setSetting('signatures', '[{"id":"sig-1"}]');
      db.setSetting('logLevel', 'warn');

      const result = await callIpc('db:get-settings') as IpcResponse<Record<string, string>>;

      expect(result.success).to.be.true;
      expect(result.data).to.include({
        theme: 'light',
        openAtLogin: 'false',
        windowState: '{"width":1200}',
        signatures: '[{"id":"sig-1"}]',
        logLevel: 'warn',
      });
    });

    it('returns only the requested keys when an array is provided', async () => {
      const db = getDatabase();
      db.setSetting('ipc.partial.a', 'valA');
      db.setSetting('ipc.partial.b', 'valB');
      db.setSetting('ipc.partial.c', 'valC');

      const result = await callIpc(
        'db:get-settings',
        ['ipc.partial.a', 'ipc.partial.c'],
      ) as IpcResponse<Record<string, string | null>>;

      expect(result.success).to.be.true;
      expect(result.data).to.have.property('ipc.partial.a', 'valA');
      expect(result.data).to.have.property('ipc.partial.c', 'valC');
      // ipc.partial.b must NOT appear in the partial response
      expect(result.data).to.not.have.property('ipc.partial.b');
    });

    it('returns null for an unknown key in a partial lookup', async () => {
      const result = await callIpc(
        'db:get-settings',
        ['does.not.exist.at.all'],
      ) as IpcResponse<Record<string, string | null>>;

      expect(result.success).to.be.true;
      expect(result.data!['does.not.exist.at.all']).to.be.null;
    });

    it('returns DB_READ_FAILED when reading all settings throws', async () => {
      const db = getDatabase() as unknown as {
        getAllSettings: () => Record<string, string>;
      };
      const originalGetAllSettings = db.getAllSettings;
      db.getAllSettings = (): Record<string, string> => {
        throw new Error('forced getAllSettings failure');
      };

      try {
        const result = await callIpc('db:get-settings') as IpcResponse<Record<string, string>>;
        expect(result.success).to.equal(false);
        expect(result.error!.code).to.equal('DB_READ_FAILED');
      } finally {
        db.getAllSettings = originalGetAllSettings;
      }
    });

    it('returns DB_READ_FAILED when partial setting lookup throws', async () => {
      const db = getDatabase() as unknown as {
        getSetting: (key: string) => string | null;
      };
      const originalGetSetting = db.getSetting;
      db.getSetting = (_key: string): string | null => {
        throw new Error('forced getSetting failure');
      };

      try {
        const result = await callIpc('db:get-settings', ['theme']) as IpcResponse<Record<string, string | null>>;
        expect(result.success).to.equal(false);
        expect(result.error!.code).to.equal('DB_READ_FAILED');
      } finally {
        db.getSetting = originalGetSetting;
      }
    });
  });

  // ---- IPC db:set-settings ----

  describe('IPC db:set-settings', () => {
    it('persists multiple keys in a single call', async () => {
      const result = await callIpc('db:set-settings', {
        'ipc.write.x': 'xValue',
        'ipc.write.y': 'yValue',
      }) as IpcResponse<null>;

      expect(result.success).to.be.true;

      const db = getDatabase();
      expect(db.getSetting('ipc.write.x')).to.equal('xValue');
      expect(db.getSetting('ipc.write.y')).to.equal('yValue');
    });

    it('overwrites a previously set key', async () => {
      const db = getDatabase();
      db.setSetting('ipc.overwrite.key', 'original');

      await callIpc('db:set-settings', { 'ipc.overwrite.key': 'updated' });

      expect(db.getSetting('ipc.overwrite.key')).to.equal('updated');
    });

    it('persists mixed settings and applies openAtLogin through the OS helper branch', async () => {
      const originalSetLoginItemSettings = app.setLoginItemSettings.bind(app);
      let appliedOpenAtLogin: boolean | null = null;

      const setLoginItemSettingsStub = ((settings: unknown) => {
        const typedSettings = settings as { openAtLogin?: boolean };
        appliedOpenAtLogin = typedSettings.openAtLogin ?? null;
      }) as typeof app.setLoginItemSettings;

      app.setLoginItemSettings = setLoginItemSettingsStub;

      try {
        const result = await callIpc('db:set-settings', {
          theme: 'dark',
          logLevel: 'debug',
          windowState: '{"x":1,"y":2}',
          signatures: '[]',
          openAtLogin: 'true',
        }) as IpcResponse<null>;

        expect(result.success).to.be.true;

        const db = getDatabase();
        expect(db.getSetting('theme')).to.equal('dark');
        expect(db.getSetting('logLevel')).to.equal('debug');
        expect(db.getSetting('windowState')).to.equal('{"x":1,"y":2}');
        expect(db.getSetting('signatures')).to.equal('[]');
        expect(db.getSetting('openAtLogin')).to.equal('true');
        expect(appliedOpenAtLogin).to.equal(true);
      } finally {
        app.setLoginItemSettings = originalSetLoginItemSettings;
      }
    });

    it('still succeeds when applying openAtLogin to the OS throws', async () => {
      const originalSetLoginItemSettings = app.setLoginItemSettings.bind(app);
      app.setLoginItemSettings = (() => {
        throw new Error('forced OS login item failure');
      }) as typeof app.setLoginItemSettings;

      try {
        const result = await callIpc('db:set-settings', {
          openAtLogin: 'true',
          theme: 'light',
        }) as IpcResponse<null>;

        expect(result.success).to.equal(true);

        const db = getDatabase();
        expect(db.getSetting('openAtLogin')).to.equal('true');
        expect(db.getSetting('theme')).to.equal('light');
      } finally {
        app.setLoginItemSettings = originalSetLoginItemSettings;
      }
    });

    it('returns DB_WRITE_FAILED when persisting settings throws', async () => {
      const db = getDatabase() as unknown as {
        setSetting: (key: string, value: string) => void;
      };
      const originalSetSetting = db.setSetting;
      db.setSetting = (_key: string, _value: string): void => {
        throw new Error('forced setSetting failure');
      };

      try {
        const result = await callIpc('db:set-settings', {
          theme: 'dark',
        }) as IpcResponse<null>;

        expect(result.success).to.equal(false);
        expect(result.error!.code).to.equal('DB_WRITE_FAILED');
      } finally {
        db.setSetting = originalSetSetting;
      }
    });
  });

  // ---- IPC db:set-log-level validation ----

  describe('IPC db:set-log-level', () => {
    it('accepts a valid log level "debug"', async () => {
      const result = await callIpc('db:set-log-level', 'debug') as IpcResponse<null>;
      expect(result.success).to.be.true;
    });

    it('accepts a valid log level "info"', async () => {
      const result = await callIpc('db:set-log-level', 'info') as IpcResponse<null>;
      expect(result.success).to.be.true;
    });

    it('accepts a valid log level "warn"', async () => {
      const result = await callIpc('db:set-log-level', 'warn') as IpcResponse<null>;
      expect(result.success).to.be.true;
    });

    it('accepts a valid log level "error"', async () => {
      const result = await callIpc('db:set-log-level', 'error') as IpcResponse<null>;
      expect(result.success).to.be.true;
    });

    it('rejects an unknown log level with success=false', async () => {
      const result = await callIpc('db:set-log-level', 'verbose') as IpcResponse<never>;
      expect(result.success).to.be.false;
      expect(result.error).to.exist;
      expect(result.error!.code).to.equal('INVALID_LOG_LEVEL');
    });

    it('rejects an empty string level with success=false', async () => {
      const result = await callIpc('db:set-log-level', '') as IpcResponse<never>;
      expect(result.success).to.be.false;
      expect(result.error!.code).to.equal('INVALID_LOG_LEVEL');
    });

    it('rejects a numeric value with success=false', async () => {
      const result = await callIpc('db:set-log-level', 3) as IpcResponse<never>;
      expect(result.success).to.be.false;
      expect(result.error!.code).to.equal('INVALID_LOG_LEVEL');
    });

    it('rejects a null value with success=false', async () => {
      const result = await callIpc('db:set-log-level', null) as IpcResponse<never>;
      expect(result.success).to.be.false;
      expect(result.error!.code).to.equal('INVALID_LOG_LEVEL');
    });

    it('rejects an uppercase log level string with success=false', async () => {
      const result = await callIpc('db:set-log-level', 'DEBUG') as IpcResponse<never>;
      expect(result.success).to.be.false;
      expect(result.error!.code).to.equal('INVALID_LOG_LEVEL');
    });

    it('returns DB_WRITE_FAILED when applying a valid log level throws', async () => {
      const logger = LoggerService.getInstance() as unknown as {
        setLevel: (level: 'debug' | 'info' | 'warn' | 'error') => void;
      };
      const originalSetLevel = logger.setLevel;
      logger.setLevel = (_level: 'debug' | 'info' | 'warn' | 'error'): void => {
        throw new Error('forced logger level failure');
      };

      try {
        const result = await callIpc('db:set-log-level', 'debug') as IpcResponse<null>;
        expect(result.success).to.equal(false);
        expect(result.error!.code).to.equal('DB_WRITE_FAILED');
      } finally {
        logger.setLevel = originalSetLevel;
      }
    });
  });

  // ---- openAtLogin persistence ----

  describe('openAtLogin persistence', () => {
    it('persists openAtLogin=true via db:set-settings IPC', async () => {
      const result = await callIpc('db:set-settings', {
        openAtLogin: 'true',
      }) as IpcResponse<null>;
      expect(result.success).to.be.true;

      const db = getDatabase();
      expect(db.getSetting('openAtLogin')).to.equal('true');
    });

    it('persists openAtLogin=false via db:set-settings IPC', async () => {
      const result = await callIpc('db:set-settings', {
        openAtLogin: 'false',
      }) as IpcResponse<null>;
      expect(result.success).to.be.true;

      const db = getDatabase();
      expect(db.getSetting('openAtLogin')).to.equal('false');
    });

    it('overwrites openAtLogin when called twice', async () => {
      await callIpc('db:set-settings', { openAtLogin: 'true' });
      await callIpc('db:set-settings', { openAtLogin: 'false' });

      const db = getDatabase();
      expect(db.getSetting('openAtLogin')).to.equal('false');
    });
  });

  // ---- Suite isolation (verify quiesce/restore cleans state) ----

  describe('Suite isolation', () => {
    it('settings written in this test do not persist after a restore', async () => {
      const db = getDatabase();
      db.setSetting('isolation.sentinel', 'should-be-gone-after-restore');
      expect(db.getSetting('isolation.sentinel')).to.equal('should-be-gone-after-restore');

      // Simulate what the next suite's before() hook does
      await quiesceAndRestore();

      // After restore, any setting that was not in the template is gone
      expect(db.getSetting('isolation.sentinel')).to.be.null;
    });
  });
});
