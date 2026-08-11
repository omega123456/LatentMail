import type { IpcCommandMap } from '@/lib/types/ipc';

export const playwrightQueueSummary: IpcCommandMap['read_queue_summary']['result'] = {
  pending: 0,
  active: 0,
  failed: 0,
  done: 0,
  paused: false,
};

export const playwrightPausedQueueSummary: IpcCommandMap['pause_queue']['result'] = {
  ...playwrightQueueSummary,
  paused: true,
};

export const playwrightResumedQueueSummary: IpcCommandMap['resume_queue']['result'] = {
  ...playwrightQueueSummary,
  paused: false,
};
