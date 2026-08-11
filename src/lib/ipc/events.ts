import { dispatchListen } from './dispatch';
import type { Unlisten } from './playwright-ipc-mock';
import type { IpcEventMap } from '@/lib/types/ipc';

export function listen<E extends keyof IpcEventMap>(
  event: E,
  listener: (payload: IpcEventMap[E]) => void,
): Promise<Unlisten> {
  return dispatchListen<IpcEventMap[E]>(event, listener);
}
