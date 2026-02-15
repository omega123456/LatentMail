import log from 'electron-log/main';
import { registerSystemIpcHandlers } from './system-ipc';
import { registerDbIpcHandlers } from './db-ipc';
import { registerMailIpcHandlers } from './mail-ipc';
import { registerAuthIpcHandlers } from './auth-ipc';
import { registerAiIpcHandlers } from './ai-ipc';
import { registerComposeIpcHandlers } from './compose-ipc';
import { registerQueueIpcHandlers } from './queue-ipc';

export function registerAllIpcHandlers(): void {
  log.info('Registering IPC handlers...');

  registerSystemIpcHandlers();
  registerDbIpcHandlers();
  registerMailIpcHandlers();
  registerAuthIpcHandlers();
  registerAiIpcHandlers();
  registerComposeIpcHandlers();
  registerQueueIpcHandlers();

  log.info('All IPC handlers registered');
}
