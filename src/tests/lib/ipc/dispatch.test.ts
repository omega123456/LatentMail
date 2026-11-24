import { describe, expect, it, vi } from 'vitest';
import { ipc } from '@/tests/ipc-mock';

function playwrightRouter() {
  return {
    invoke: vi.fn().mockResolvedValue({ status: 'routed' }),
    listen: vi.fn().mockResolvedValue(() => undefined),
    convertFileSrc: vi.fn(() => 'data:image/svg+xml,fixture'),
  };
}

describe('IPC dispatch', () => {
  it('routes commands through the Tauri runtime when it is present', async () => {
    ipc.override('health_check', { status: 'ok' });
    const { invoke } = await import('@/lib/ipc/commands');

    await expect(invoke('health_check', {})).resolves.toEqual({ status: 'ok' });
    expect(ipc.tauriInvoke).toHaveBeenCalledWith('health_check', {});
  });

  it('sends every call to the Playwright router once one is installed', async () => {
    const router = playwrightRouter();
    ipc.usePlaywrightRouter(router);
    const {
      dispatchConvertFileSrc,
      dispatchEmit,
      dispatchInvoke,
      dispatchListen,
      dispatchSetZoom,
    } = await import('@/lib/ipc/dispatch');
    const listener = vi.fn();

    await expect(dispatchInvoke('health_check', {})).resolves.toEqual({ status: 'routed' });
    await dispatchListen('avatar://resolved', listener);
    await dispatchEmit('frontend://ready', {});
    await dispatchSetZoom(1.5);

    expect(router.invoke).toHaveBeenCalledWith('health_check', {});
    expect(router.listen).toHaveBeenCalledWith('avatar://resolved', listener);
    expect(dispatchConvertFileSrc('/avatar-cache/a.png')).toBe('data:image/svg+xml,fixture');
    expect(ipc.tauriInvoke).not.toHaveBeenCalled();
    expect(ipc.tauriEmit).not.toHaveBeenCalled();
    expect(ipc.tauriSetZoom).not.toHaveBeenCalled();
  });

  it('ignores native file drops under the Playwright router', async () => {
    ipc.usePlaywrightRouter(playwrightRouter());
    const { dispatchOnDragDrop } = await import('@/lib/ipc/dispatch');

    const unlisten = await dispatchOnDragDrop(vi.fn());

    expect(unlisten()).toBeUndefined();
    expect(ipc.tauriOnDragDropEvent).not.toHaveBeenCalled();
  });

  it('delivers typed events to subscribers', async () => {
    const { listen } = await import('@/lib/ipc/events');
    const received = vi.fn();

    await listen('avatar://resolved', received);
    ipc.emit('avatar://resolved', { pipeline: 'sender', key: 'anna@example.com', resolved: true });

    expect(received).toHaveBeenCalledWith({
      pipeline: 'sender',
      key: 'anna@example.com',
      resolved: true,
    });
  });

  it('emits frontend readiness through the shared dispatch boundary', async () => {
    const { emitFrontendReady } = await import('@/lib/ipc/events');

    await emitFrontendReady();

    expect(ipc.tauriEmit).toHaveBeenCalledWith('frontend://ready', {});
  });

  it('zooms the webview and converts file paths through the Tauri runtime', async () => {
    const { dispatchConvertFileSrc, dispatchSetZoom } = await import('@/lib/ipc/dispatch');

    await dispatchSetZoom(1.5);

    expect(ipc.tauriSetZoom).toHaveBeenCalledWith(1.5);
    expect(dispatchConvertFileSrc('/cache/a.png')).toBe(
      `asset://localhost/${encodeURIComponent('/cache/a.png')}`,
    );
  });

  it('skips the webview zoom, emits and file drops when there is no Tauri runtime', async () => {
    ipc.useTauriApi();
    const { dispatchEmit, dispatchOnDragDrop, dispatchSetZoom } =
      await import('@/lib/ipc/dispatch');

    await expect(dispatchSetZoom(1.5)).resolves.toBeUndefined();
    await expect(dispatchEmit('frontend://ready', {})).resolves.toBeUndefined();
    await dispatchOnDragDrop(vi.fn());

    expect(ipc.tauriSetZoom).not.toHaveBeenCalled();
    expect(ipc.tauriEmit).not.toHaveBeenCalled();
    expect(ipc.tauriOnDragDropEvent).not.toHaveBeenCalled();
  });

  it('still routes commands and subscriptions through the Tauri API without a runtime', async () => {
    ipc.override('health_check', () => ({ status: 'ok' }));
    ipc.useTauriApi();
    const { invoke } = await import('@/lib/ipc/commands');
    const { listen } = await import('@/lib/ipc/events');
    const received = vi.fn();

    await expect(invoke('health_check', {})).resolves.toEqual({ status: 'ok' });
    await listen('avatar://resolved', received);
    expect(ipc.tauriListen).toHaveBeenCalledWith('avatar://resolved', expect.any(Function));
  });

  it('rejects commands without a fixture', async () => {
    const { dispatchInvoke } = await import('@/lib/ipc/dispatch');

    await expect(dispatchInvoke('missing_command', {})).rejects.toThrow(
      '[vitest] Unmocked Tauri IPC command: missing_command',
    );
  });
});
