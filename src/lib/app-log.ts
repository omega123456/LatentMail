// Deliberately the low-level dispatch rather than `@/lib/ipc/commands`: that
// module logs failures through here, and importing it back would be a cycle.
import { dispatchInvoke } from '@/lib/ipc/dispatch';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function write(level: LogLevel, message: string) {
  // A logger must never become the error: swallow both a synchronous dispatch
  // failure and a rejected write, and always leave the console record behind.
  try {
    void dispatchInvoke<void>('write_frontend_log', { level, message }).catch(() => undefined);
  } catch {
    /* the console record below is the fallback */
  }
  console[level](message);
}

export const appLog = {
  debug: (message: string) => write('debug', message),
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
};
