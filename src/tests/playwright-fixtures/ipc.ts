// Pure composition of the per-domain fixture files below into the full
// default response map the Playwright IPC router falls back to. Never add
// fixture data inline here — extend the relevant domain file instead.
import type { IpcCommandMap } from '@/lib/types/ipc';
import { playwrightSidebarAccounts } from './accounts';
import { playwrightLabels } from './labels';
import { playwrightThreadPage } from './threads';
import { playwrightConversation } from './conversations';
import { playwrightSyncStatus, playwrightTriggerSyncResult } from './sync';
import { playwrightSettings } from './settings';
import {
  playwrightPausedQueueSummary,
  playwrightQueueSummary,
  playwrightResumedQueueSummary,
} from './queue';

export const playwrightIpcFixtures: { [C in keyof IpcCommandMap]: IpcCommandMap[C]['result'] } = {
  health_check: { status: 'ok' },
  open_external_url: undefined,
  write_frontend_log: undefined,
  read_settings: playwrightSettings,
  write_setting: undefined,
  pause_queue: playwrightPausedQueueSummary,
  resume_queue: playwrightResumedQueueSummary,
  read_queue_summary: playwrightQueueSummary,
  list_accounts: [],
  begin_sign_in: undefined,
  begin_reauthentication: undefined,
  list_labels: playwrightLabels,
  list_threads: playwrightThreadPage,
  load_conversation: playwrightConversation,
  trigger_sync: playwrightTriggerSyncResult,
  read_sync_status: playwrightSyncStatus,
  star_thread: undefined,
  unstar_thread: undefined,
  mark_thread_read: undefined,
  mark_thread_unread: undefined,
};

export { playwrightSidebarAccounts };
