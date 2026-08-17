import { dispatchInvoke } from './dispatch';
import { appLog } from '@/lib/app-log';
import type { IpcCommandMap } from '@/lib/types/ipc';

export async function invoke<C extends keyof IpcCommandMap>(
  command: C,
  args: IpcCommandMap[C]['args'],
): Promise<IpcCommandMap[C]['result']> {
  try {
    return await dispatchInvoke<IpcCommandMap[C]['result']>(command, args);
  } catch (cause) {
    if (command !== 'write_frontend_log') {
      appLog.error(
        `ipc ${command} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    throw cause;
  }
}
