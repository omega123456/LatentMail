import { dispatchInvoke } from '@/lib/ipc/dispatch';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function write(level: LogLevel, message: string) {
  try {
    void dispatchInvoke<void>('write_frontend_log', { level, message }).catch(() => undefined);
  } catch (error) {
    void error;
  }
  console[level](message);
}

export const appLog = {
  debug: (message: string) => write('debug', message),
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
};
