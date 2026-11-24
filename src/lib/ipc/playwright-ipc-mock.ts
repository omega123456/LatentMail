export type Unlisten = () => void | Promise<void>;

export type PlaywrightIpc = {
  invoke(command: string, request: unknown): Promise<unknown>;
  listen(event: string, listener: (payload: unknown) => void): Promise<Unlisten>;
  convertFileSrc(path: string): string;
};

declare global {
  interface Window {
    __LATENTMAIL_PLAYWRIGHT_IPC__?: PlaywrightIpc;
    __LATENTMAIL_PLAYWRIGHT_IPC_CALLS__?: { command: string; request: unknown }[];
    __LATENTMAIL_PLAYWRIGHT_EMIT__?: (event: string, payload: unknown) => void;
  }
}
