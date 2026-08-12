import { afterEach, expect, it, vi } from 'vitest';
import { invoke } from '@/lib/ipc/commands';
import { ipc } from '@/tests/ipc-mock';

afterEach(() => vi.restoreAllMocks());

it('logs every failed command centrally and still rejects', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const logged = vi.fn();
  ipc.override('write_frontend_log', logged);
  ipc.override('list_threads', () => {
    throw new Error('no such table: threads');
  });

  await expect(invoke('list_threads', { accountId: 'a', labelId: 'INBOX' })).rejects.toThrow(
    'no such table: threads',
  );

  const message = 'ipc list_threads failed: no such table: threads';
  expect(consoleError).toHaveBeenCalledWith(message);
  expect(logged).toHaveBeenCalledWith({ level: 'error', message });
});

it('does not recurse when the log command itself fails', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  ipc.override('write_frontend_log', () => {
    throw new Error('log sink is gone');
  });

  await expect(invoke('write_frontend_log', { level: 'error', message: 'x' })).rejects.toThrow(
    'log sink is gone',
  );

  expect(consoleError).not.toHaveBeenCalled();
});

it('leaves successful commands untouched', async () => {
  await expect(invoke('list_accounts', {})).resolves.toEqual([]);
});
