import { getCurrentWebview } from '@tauri-apps/api/webview';
import type { DragDropEvent } from '@/lib/types/ipc';

type Unlisten = () => void;

function hasTauriRuntime(): boolean {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export function subscribeToFileDrop(onDrop: (paths: string[]) => void): Unlisten {
  if (!hasTauriRuntime()) {
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
