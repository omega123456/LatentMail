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
    // Every IPC failure gets logged here, once: callers turn a rejection into
    // an error state ("Couldn't load conversations"), which tells nobody what
    // Rust actually said. Skip the log command itself — it would recurse.
    if (command !== 'write_frontend_log') {
      appLog.error(
        `ipc ${command} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    throw cause;
  }
}
