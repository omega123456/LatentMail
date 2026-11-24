import { convertFileSrc as tauriConvertFileSrc, invoke as tauriInvoke } from '@tauri-apps/api/core';
import type { InvokeArgs } from '@tauri-apps/api/core';
import { emit as tauriEmit, listen as tauriListen } from '@tauri-apps/api/event';
import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { DragDropEvent } from '@/lib/types/ipc';
import type { PlaywrightIpc, Unlisten } from './playwright-ipc-mock';

type IpcTransport = {
  invoke(command: string, request: unknown): Promise<unknown>;
  listen(event: string, listener: (payload: unknown) => void): Promise<Unlisten>;
  emit(event: string, payload: unknown): Promise<void>;
  setZoom(scale: number): Promise<void>;
  convertFileSrc(path: string): string;
  onDragDrop(handler: (event: DragDropEvent) => void): Promise<Unlisten>;
};

const resolveNothing = () => Promise.resolve();
const ignoreDragDrop = () => Promise.resolve<Unlisten>(() => undefined);

const tauriTransport: IpcTransport = {
  invoke: (command, request) => tauriInvoke(command, request as InvokeArgs),
  listen: (event, listener) => tauriListen(event, ({ payload }) => listener(payload)),
  emit: (event, payload) => tauriEmit(event, payload),
  setZoom: (scale) => getCurrentWebview().setZoom(scale),
  convertFileSrc: (path) => tauriConvertFileSrc(path),
  onDragDrop: (handler) => getCurrentWebview().onDragDropEvent(({ payload }) => handler(payload)),
};

const runtimelessTransport: IpcTransport = {
  ...tauriTransport,
  emit: resolveNothing,
  setZoom: resolveNothing,
  onDragDrop: ignoreDragDrop,
};

function playwrightTransport(router: PlaywrightIpc): IpcTransport {
  return {
    invoke: router.invoke,
    listen: router.listen,
    emit: resolveNothing,
    setZoom: resolveNothing,
    convertFileSrc: router.convertFileSrc,
    onDragDrop: ignoreDragDrop,
  };
}

function hasTauriRuntime() {
  return '__TAURI_INTERNALS__' in window;
}

function activeTransport(): IpcTransport {
  const router = window.__LATENTMAIL_PLAYWRIGHT_IPC__;
  if (router) return playwrightTransport(router);
  if (hasTauriRuntime()) return tauriTransport;
  return runtimelessTransport;
}

export function dispatchInvoke<Result>(command: string, request: unknown): Promise<Result> {
  return activeTransport().invoke(command, request) as Promise<Result>;
}

export function dispatchListen<Payload>(
  event: string,
  listener: (payload: Payload) => void,
): Promise<Unlisten> {
  return activeTransport().listen(event, listener as (payload: unknown) => void);
}

export function dispatchEmit(event: string, payload: unknown): Promise<void> {
  return activeTransport().emit(event, payload);
}

export function dispatchSetZoom(scale: number): Promise<void> {
  return activeTransport().setZoom(scale);
}

export function dispatchConvertFileSrc(path: string): string {
  return activeTransport().convertFileSrc(path);
}

export function dispatchOnDragDrop(handler: (event: DragDropEvent) => void): Promise<Unlisten> {
  return activeTransport().onDragDrop(handler);
}
