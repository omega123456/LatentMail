import { describe, expect, it, vi } from 'vitest';
import { ipc } from '@/tests/ipc-mock';
import { playwrightIpcFixtures } from '@/tests/playwright-fixtures';
import { playwrightAvatarFixtureMark } from '@/tests/playwright-fixtures/avatars';

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

  it('emits frontend readiness through the shared dispatch boundary', async () => {
    const { emitFrontendReady } = await import('@/lib/ipc/events');

    await emitFrontendReady();

    expect(ipc.tauriEmit).toHaveBeenCalledWith('frontend://ready', {});
  });

  it('skips the webview zoom call when there is no Tauri runtime', async () => {
    ipc.useTauriApi();
    const { dispatchSetZoom } = await import('@/lib/ipc/dispatch');

    await expect(dispatchSetZoom(1.5)).resolves.toBeUndefined();
    expect(ipc.tauriSetZoom).not.toHaveBeenCalled();
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

    await expect(invoke('health_check', {})).rejects.toThrow(
      'Playwright IPC router is not installed',
    );
    expect(error).toHaveBeenCalledWith(
      'ipc health_check failed: Playwright IPC router is not installed',
    );
    error.mockRestore();
    vi.unstubAllEnvs();
  });

  it('resolves the avatar Playwright fixtures to the fixture mark, not the grey placeholder', async () => {
    vi.stubEnv('VITE_PLAYWRIGHT', 'true');
    const { dispatchConvertFileSrc } = await import('@/lib/ipc/dispatch');

    const senderAvatarPath = playwrightIpcFixtures.read_sender_avatar;
    const accountAvatarPath = playwrightIpcFixtures.read_account_avatar;
    expect(senderAvatarPath).toBeTruthy();
    expect(accountAvatarPath).toBeTruthy();
    expect(dispatchConvertFileSrc(senderAvatarPath as string)).toBe(playwrightAvatarFixtureMark);
    expect(dispatchConvertFileSrc(accountAvatarPath as string)).toBe(playwrightAvatarFixtureMark);
    vi.unstubAllEnvs();
  });
});
