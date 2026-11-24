import { listen } from './events';
import type { IpcEventMap } from '@/lib/types/ipc';

export function listenUntilDisposed<Event extends keyof IpcEventMap>(
  event: Event,
  handler: (payload: IpcEventMap[Event]) => void,
): () => void {
  let disposed = false;
  let unlisten: (() => void | Promise<void>) | undefined;
  void listen(event, handler).then((remove) => {
    if (disposed) {
      void remove();
      return;
    }
    unlisten = remove;
  });
  return () => {
    disposed = true;
    void unlisten?.();
  };
}
