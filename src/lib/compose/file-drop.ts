import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { DragDropEvent } from '@/lib/types/ipc';

type Unlisten = () => void;

/** True while running under a real Tauri webview (`window.__TAURI_INTERNALS__`
 * is only ever set there, never under Vite/Playwright) — the same
 * environment check `src/lib/ipc/dispatch.ts` uses for every other
 * dual-path Tauri/Playwright call. `getCurrentWebview()` reads
 * `window.__TAURI_INTERNALS__.metadata`, which the Playwright harness never
 * populates, so calling it there throws rather than no-oping. */
function hasTauriRuntime(): boolean {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

/** Subscribes to the current window's native OS drag-drop events (D7 — not
 * HTML5 drag-and-drop, which the window's Tauri drag-drop setting staying
 * at its default deliberately leaves unused). Calls `onDrop` with the
 * dropped file paths; the caller stages them exactly like a picker
 * selection. Returns a teardown function the composer calls on unmount —
 * this is the app's only native drop consumer, so nothing else contends for
 * the subscription (D7). */
export function subscribeToFileDrop(onDrop: (paths: string[]) => void): Unlisten {
  if (!hasTauriRuntime()) {
    // ponytail: no native drag-drop under Playwright/jsdom — there is no
    // OS-level drop surface to subscribe to there, so this intentionally
    // no-ops rather than fake a subscription. Screenshot/e2e coverage for
    // drop itself lives in Vitest, which mocks the Tauri webview layer.
    return () => undefined;
  }
  let disposed = false;
  let unlisten: Unlisten | undefined;
  void getCurrentWebview()
    .onDragDropEvent(({ payload }: { payload: DragDropEvent }) => {
      if (payload.type === 'drop') onDrop(payload.paths);
    })
    .then((dispose) => {
      if (disposed) {
        void dispose();
        return;
      }
      unlisten = dispose;
    });
  return () => {
    disposed = true;
    unlisten?.();
  };
}
