import { dispatchInvoke } from './dispatch';
import type { IpcCommandMap } from '@/lib/types/ipc';

export function invoke<C extends keyof IpcCommandMap>(
  command: C,
  args: IpcCommandMap[C]['args'],
): Promise<IpcCommandMap[C]['result']> {
  return dispatchInvoke<IpcCommandMap[C]['result']>(command, args);
}
