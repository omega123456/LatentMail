import { SyncQueueBridge } from '../services/sync-queue-bridge';

/** Result shape returned by every command handler. */
export interface CommandResult {
  ok: boolean;
  message: string;
}

type CommandHandler = () => Promise<CommandResult>;

/** Registry mapping command name strings to handler functions. */
const registry: Record<string, CommandHandler> = {
  'pause-sync': async (): Promise<CommandResult> => {
    const bridge = SyncQueueBridge.getInstance();
    if (bridge.isPaused()) {
      return { ok: true, message: 'Sync is already paused.' };
    }
    bridge.pause();
    return { ok: true, message: 'Background sync paused.' };
  },

  'resume-sync': async (): Promise<CommandResult> => {
    const bridge = SyncQueueBridge.getInstance();
    if (!bridge.isPaused()) {
      return { ok: true, message: 'Sync is not paused.' };
    }
    bridge.resume();
    return { ok: true, message: 'Background sync resumed.' };
  },
};

/**
 * Dispatch a command by name to its registered handler.
 * Returns a structured error response for unknown commands.
 */
export async function dispatchCommand(command: string): Promise<CommandResult> {
  const handler = registry[command];
  if (!handler) {
    const available = getAvailableCommands().join(', ');
    return { ok: false, message: `Unknown command: "${command}". Available commands: ${available}` };
  }
  return handler();
}

/** Returns the list of registered command names. */
export function getAvailableCommands(): string[] {
  return Object.keys(registry);
}
