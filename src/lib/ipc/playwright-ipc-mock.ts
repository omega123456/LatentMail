import type { OpenComposeArgs } from '@/stores/compose';

export type Unlisten = () => void | Promise<void>;

type PlaywrightIpc = {
  invoke(command: string, args: unknown): Promise<unknown>;
  listen(event: string, listener: (payload: unknown) => void): Promise<Unlisten>;
};

declare global {
  interface Window {
    __LATENTMAIL_PLAYWRIGHT_IPC__?: PlaywrightIpc;
    __LATENTMAIL_PLAYWRIGHT_READER_STATE__?: 'loading' | 'error';
    /** Playwright opens the composer directly through this bridge so its
     * own screenshot scenarios can exercise the mounted panel without
     * driving the real Compose pill/keyboard/ribbon entry points.
     * `MailLayout` reads it once on mount, exactly like
     * `__LATENTMAIL_PLAYWRIGHT_READER_STATE__` above. */
    __LATENTMAIL_PLAYWRIGHT_COMPOSE_SESSION__?: OpenComposeArgs;
  }
}

function router(): PlaywrightIpc {
  if (!window.__LATENTMAIL_PLAYWRIGHT_IPC__) {
    throw new Error('Playwright IPC router is not installed');
  }

  return window.__LATENTMAIL_PLAYWRIGHT_IPC__;
}

export const playwrightIpcMock = {
  invoke: (command: string, args: unknown) => router().invoke(command, args),
  listen: (event: string, listener: (payload: unknown) => void) => router().listen(event, listener),
};
