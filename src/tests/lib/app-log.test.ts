import { afterEach, describe, expect, it, vi } from 'vitest';
import { appLog } from '@/lib/app-log';
import { ipc } from '@/tests/ipc-mock';

describe('appLog', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each(['debug', 'info', 'warn', 'error'] as const)('routes %s records through IPC', (level) => {
    const record = vi.fn();
    const consoleMethod = vi.spyOn(console, level).mockImplementation(() => undefined);
    ipc.override('write_frontend_log', record);

    appLog[level]('A frontend record');

    expect(record).toHaveBeenCalledWith({ level, message: 'A frontend record' });
    expect(consoleMethod).toHaveBeenCalledWith('A frontend record');
  });

  it('still leaves a console record when the IPC write itself rejects', async () => {
    const consoleMethod = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    ipc.override('write_frontend_log', () => {
      throw new Error('dispatch unavailable');
    });

    appLog.error('Unreachable backend');

    // The rejection is swallowed asynchronously (`.catch(() => undefined)`);
    // flush microtasks before asserting nothing escaped as an unhandled
    // rejection and the console fallback still ran.
    await Promise.resolve();
    expect(consoleMethod).toHaveBeenCalledWith('Unreachable backend');
  });
});
