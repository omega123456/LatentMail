import { LoggerService } from '../services/logger-service';
import { registerSystemIpcHandlers } from './system-ipc';

const log = LoggerService.getInstance();
import { registerDbIpcHandlers } from './db-ipc';
import { registerMailIpcHandlers } from './mail-ipc';
import { registerAuthIpcHandlers } from './auth-ipc';
import { registerAiIpcHandlers } from './ai-ipc';
import { registerComposeIpcHandlers } from './compose-ipc';
import { registerQueueIpcHandlers } from './queue-ipc';
import { registerFilterIpcHandlers } from './filter-ipc';
import { registerLoggerIpcHandlers } from './logger-ipc';

export function registerAllIpcHandlers(): void {
  log.info('Registering IPC handlers...');

  registerSystemIpcHandlers();
  registerDbIpcHandlers();
  registerMailIpcHandlers();
  registerAuthIpcHandlers();
  registerAiIpcHandlers();
  registerComposeIpcHandlers();
  registerQueueIpcHandlers();
  registerFilterIpcHandlers();
  registerLoggerIpcHandlers();

  log.info('All IPC handlers registered');
}
