export type Unlisten = () => void | Promise<void>;

type PlaywrightIpc = {
  invoke(command: string, args: unknown): Promise<unknown>;
  listen(event: string, listener: (payload: unknown) => void): Promise<Unlisten>;
};

declare global {
  interface Window {
    __LATENTMAIL_PLAYWRIGHT_IPC__?: PlaywrightIpc;
    __LATENTMAIL_PLAYWRIGHT_READER_STATE__?: 'loading' | 'error';
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
