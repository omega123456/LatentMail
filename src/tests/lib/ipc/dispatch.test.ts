import { describe, expect, it, vi } from 'vitest';
import { ipc } from '@/tests/ipc-mock';

describe('IPC dispatch', () => {
  it('uses the Tauri IPC global when it is present', async () => {
    const globalInvoke = vi.fn().mockResolvedValue({ status: 'ok' });
    (
      window as Window & { __TAURI_INTERNALS__?: { invoke: typeof globalInvoke } }
    ).__TAURI_INTERNALS__ = {
      invoke: globalInvoke,
    };
    const { invoke } = await import('@/lib/ipc/commands');

    await expect(invoke('health_check', {})).resolves.toEqual({ status: 'ok' });
    expect(globalInvoke).toHaveBeenCalledWith('health_check', {});
  });

  it('uses the Playwright router', async () => {
    vi.stubEnv('VITE_PLAYWRIGHT', 'true');
    ipc.useTauriApi();
    const routerInvoke = vi.fn().mockResolvedValue({ status: 'ok' });
    window.__LATENTMAIL_PLAYWRIGHT_IPC__ = { invoke: routerInvoke, listen: vi.fn() };
    const { invoke } = await import('@/lib/ipc/commands');

    await expect(invoke('health_check', {})).resolves.toEqual({ status: 'ok' });
    expect(routerInvoke).toHaveBeenCalledWith('health_check', {});
    vi.unstubAllEnvs();
  });

  it('falls back to the Tauri API', async () => {
    ipc.useTauriApi();
    const { invoke } = await import('@/lib/ipc/commands');

    await expect(invoke('health_check', {})).resolves.toEqual({ status: 'ok' });
    expect(ipc.tauriInvoke).toHaveBeenCalledWith('health_check', {});
  });

  it('delivers typed events to subscribers', async () => {
    const { listen } = await import('@/lib/ipc/events');
    const received = vi.fn();

    await listen('system://health', received);
    ipc.emit('system://health', { status: 'ok' });

    expect(received).toHaveBeenCalledWith({ status: 'ok' });
  });

  it('supports overrides and Tauri event subscriptions through the shared harness', async () => {
    ipc.override('health_check', () => ({ status: 'ok' }));
    ipc.useTauriApi();
    const { invoke } = await import('@/lib/ipc/commands');
    const { listen } = await import('@/lib/ipc/events');
    const received = vi.fn();

    await expect(invoke('health_check', {})).resolves.toEqual({ status: 'ok' });
    await listen('system://health', received);
    expect(ipc.tauriListen).toHaveBeenCalledWith('system://health', expect.any(Function));
  });

  it('rejects commands without a fixture', async () => {
    const { dispatchInvoke } = await import('@/lib/ipc/dispatch');

    await expect(dispatchInvoke('missing_command', {})).rejects.toThrow(
      '[vitest] Unmocked Tauri IPC command: missing_command',
    );
  });

  it('requires the Playwright router when that dispatch path is selected', async () => {
    vi.stubEnv('VITE_PLAYWRIGHT', 'true');
    ipc.useTauriApi();
    delete window.__LATENTMAIL_PLAYWRIGHT_IPC__;
    const { invoke } = await import('@/lib/ipc/commands');
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // `invoke` reports every failure as a rejection, including the ones
    // `dispatchInvoke` raises synchronously, so callers only need one path.
    await expect(invoke('health_check', {})).rejects.toThrow(
      'Playwright IPC router is not installed',
    );
    expect(error).toHaveBeenCalledWith(
      'ipc health_check failed: Playwright IPC router is not installed',
    );
    error.mockRestore();
    vi.unstubAllEnvs();
  });
});
