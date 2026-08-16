import { convertFileSrc as tauriConvertFileSrc, invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';
import { playwrightIpcMock, type Unlisten } from './playwright-ipc-mock';
import { playwrightAvatarFixtureMark } from '@/tests/playwright-fixtures/avatars';

const playwrightPlaceholderAssetUrl =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='%23c1c6d7'/%3E%3C/svg%3E";

/** The plan's on-disk cache layout (`avatar-cache/senders/...`,
 * `avatar-cache/accounts/...`) is what distinguishes an avatar path from any
 * other staged path this resolver sees. */
const AVATAR_CACHE_PATH_MARKER = 'avatar-cache';

type TauriInternals = { invoke?: (command: string, args: unknown) => Promise<unknown> };

function tauriGlobal(): TauriInternals | undefined {
  return (window as Window & { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
}

export function dispatchInvoke<Result>(command: string, args: unknown): Promise<Result> {
  const invoke = tauriGlobal()?.invoke;
  if (invoke) {
    return invoke(command, args) as Promise<Result>;
  }

  if (import.meta.env.VITE_PLAYWRIGHT || window.__LATENTMAIL_PLAYWRIGHT_IPC__) {
    return playwrightIpcMock.invoke(command, args) as Promise<Result>;
  }

  return tauriInvoke<Result>(command, args as Record<string, unknown>);
}

export function dispatchListen<Payload>(
  event: string,
  listener: (payload: Payload) => void,
): Promise<Unlisten> {
  if (import.meta.env.VITE_PLAYWRIGHT || window.__LATENTMAIL_PLAYWRIGHT_IPC__) {
    return playwrightIpcMock.listen(event, listener as (payload: unknown) => void);
  }

  return tauriListen<Payload>(event, ({ payload }) => listener(payload));
}

/** Resolves a Rust-staged path to a previewable URL. Under Playwright there
 * is no live Tauri asset-protocol registration to resolve against, so this
 * returns a small inline placeholder instead — enough to keep inline-image
 * screenshot scenarios meaningful without a real backend. An avatar-cache
 * path gets the dark-ink fixture mark instead of the generic grey square, so
 * the plate and ring are genuinely verifiable in a screenshot baseline. */
export function dispatchConvertFileSrc(path: string): string {
  if (import.meta.env.VITE_PLAYWRIGHT || window.__LATENTMAIL_PLAYWRIGHT_IPC__) {
    return path.includes(AVATAR_CACHE_PATH_MARKER)
      ? playwrightAvatarFixtureMark
      : playwrightPlaceholderAssetUrl;
  }
  return tauriConvertFileSrc(path);
}
