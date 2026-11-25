import { vi } from 'vitest';
import { ipcFixtures } from '@/tests/fixtures';
import type { IpcCommandMap, IpcEventMap } from '@/lib/types/ipc';
import type { PlaywrightIpc } from '@/lib/ipc/playwright-ipc-mock';

type Listener = (payload: unknown) => void;
type Override<C extends keyof IpcCommandMap> =
  | (C extends 'read_settings' ? Partial<IpcCommandMap[C]['result']> : IpcCommandMap[C]['result'])
  | ((
      request: IpcCommandMap[C]['args'],
    ) => IpcCommandMap[C]['result'] | Promise<IpcCommandMap[C]['result']>);

const overrides = new Map<keyof IpcCommandMap, Override<keyof IpcCommandMap>>();
const listeners = new Map<keyof IpcEventMap, Set<Listener>>();

const tauriInvoke = vi.fn(async (command: string, request: unknown) => invoke(command, request));
const tauriListen = vi.fn(
  async (event: string, listener: (event: { payload: unknown }) => void) => {
    const wrapped: Listener = (payload) => listener({ payload });
    const eventListeners = listeners.get(event as keyof IpcEventMap) ?? new Set();
    eventListeners.add(wrapped);
    listeners.set(event as keyof IpcEventMap, eventListeners);
    return () => eventListeners.delete(wrapped);
  },
);
const tauriEmit = vi.fn(async () => undefined);

const tauriConvertFileSrc = vi.fn(
  (path: string, protocol = 'asset') => `${protocol}://localhost/${encodeURIComponent(path)}`,
);
vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauriInvoke,
  convertFileSrc: tauriConvertFileSrc,
}));
vi.mock('@tauri-apps/api/event', () => ({ emit: tauriEmit, listen: tauriListen }));

const tauriOnDragDropEvent = vi.fn(async (handler: (event: { payload: unknown }) => void) => {
  const wrapped: Listener = (payload) => handler({ payload });
  const key = 'tauri://drag-drop' as keyof IpcEventMap;
  const eventListeners = listeners.get(key) ?? new Set();
  eventListeners.add(wrapped);
  listeners.set(key, eventListeners);
  return () => eventListeners.delete(wrapped);
});
const tauriSetZoom = vi.fn(async () => undefined);
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: tauriOnDragDropEvent, setZoom: tauriSetZoom }),
}));

function withSettingsDefaults(settings: unknown): unknown {
  const isSettingsObject = typeof settings === 'object' && settings !== null;
  return isSettingsObject ? { ...ipcFixtures.read_settings, ...settings } : settings;
}

function invoke(command: string, request: unknown): Promise<unknown> {
  const key = command as keyof IpcCommandMap;
  const override = overrides.get(key);
  if (override !== undefined) {
    const value = typeof override === 'function' ? override(request as never) : override;
    if (key === 'read_settings') return Promise.resolve(value).then(withSettingsDefaults);
    return Promise.resolve(value);
  }
  if (!(key in ipcFixtures)) {
    return Promise.reject(new Error(`[vitest] Unmocked Tauri IPC command: ${command}`));
  }
  return Promise.resolve(ipcFixtures[key]);
}

function install() {
  (window as Window & { __TAURI_INTERNALS__?: { invoke: typeof invoke } }).__TAURI_INTERNALS__ = {
    invoke,
  };
}

export const ipc = {
  install,
  reset() {
    overrides.clear();
    listeners.clear();
    tauriInvoke.mockClear();
    tauriListen.mockClear();
    tauriEmit.mockClear();
    tauriOnDragDropEvent.mockClear();
    tauriSetZoom.mockClear();
    tauriConvertFileSrc.mockClear();
    delete window.__LATENTMAIL_PLAYWRIGHT_IPC__;
    install();
  },
  override<C extends keyof IpcCommandMap>(command: C, response: Override<C>) {
    overrides.set(command, response as Override<keyof IpcCommandMap>);
  },
  recordCalls<C extends keyof IpcCommandMap>(
    command: C,
    response?: Override<C>,
  ): IpcCommandMap[C]['args'][] {
    const calls: IpcCommandMap[C]['args'][] = [];
    const fallback = command in ipcFixtures ? ipcFixtures[command] : undefined;
    overrides.set(command, ((request: IpcCommandMap[C]['args']) => {
      calls.push(request);
      if (typeof response === 'function') return response(request);
      return response !== undefined ? response : fallback;
    }) as Override<keyof IpcCommandMap>);
    return calls;
  },
  emit<E extends keyof IpcEventMap>(event: E, payload: IpcEventMap[E]) {
    listeners.get(event)?.forEach((listener) => listener(payload));
  },
  useTauriApi() {
    delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  },
  usePlaywrightRouter(router: PlaywrightIpc) {
    window.__LATENTMAIL_PLAYWRIGHT_IPC__ = router;
  },
  tauriInvoke,
  tauriListen,
  tauriEmit,
  tauriOnDragDropEvent,
  tauriSetZoom,
  tauriConvertFileSrc,
};
