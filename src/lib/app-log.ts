import { invoke } from '@/lib/ipc/commands';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

function write(level: LogLevel, message: string) {
  void invoke('write_frontend_log', { level, message });
  console[level](message);
}

export const appLog = {
  debug: (message: string) => write('debug', message),
  info: (message: string) => write('info', message),
  warn: (message: string) => write('warn', message),
  error: (message: string) => write('error', message),
};
