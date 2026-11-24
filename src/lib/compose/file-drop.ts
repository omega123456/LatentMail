import { dispatchOnDragDrop } from '@/lib/ipc/dispatch';
import type { Unlisten } from '@/lib/ipc/playwright-ipc-mock';

export function subscribeToFileDrop(onDrop: (paths: string[]) => void): () => void {
  let disposed = false;
  let unlisten: Unlisten | undefined;
  void dispatchOnDragDrop((event) => {
    if (event.type === 'drop') onDrop(event.paths);
  }).then((dispose) => {
    if (disposed) {
      void dispose();
      return;
    }
    unlisten = dispose;
  });
  return () => {
    disposed = true;
    void unlisten?.();
  };
}
