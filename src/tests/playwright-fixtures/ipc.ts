// Pure composition of the per-domain fixture files below into the full
// default response map the Playwright IPC router falls back to. Never add
// fixture data inline here — extend the relevant domain file instead.
import type { IpcCommandMap } from '@/lib/types/ipc';
import { playwrightSidebarAccounts } from './accounts';
import { playwrightCreatedLabel, playwrightLabels, playwrightMutationResults } from './labels';
import { playwrightThreadPage } from './threads';
import { playwrightConversation } from './conversations';
import { playwrightSyncStatus, playwrightTriggerSyncResult } from './sync';
import { playwrightTraversalStatus } from './traversal';
import { playwrightSettings } from './settings';
import { playwrightContactSuggestions, playwrightStagedAttachment } from './compose';
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
  lookup_contacts: playwrightContactSuggestions,
  reply_context: {
    to: [],
    cc: [],
    subject: '',
    originalMessageId: '',
    targetThreadId: null,
    inReplyTo: null,
    references: [],
    originalGmailMessageId: '',
    displayQuote: null,
  },
  stage_attachment_from_path: playwrightStagedAttachment,
  stage_attachment_from_bytes: playwrightStagedAttachment,
  release_staged_attachment: undefined,
  save_compose_draft: { operationId: 'draft-operation', draftId: 'draft-1' },
  send_compose_draft: { operationId: 'send-operation', draftId: 'draft-1' },
  discard_compose_draft: undefined,
  hydrate_compose_draft: {
    sessionId: 'session-1',
    accountId: 'account-1',
    draftId: 'draft-1',
    from: 'alex@example.com',
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    html: '',
    quoteHtml: null,
    quotePlain: null,
    mode: 'draft',
    threadId: null,
    inReplyTo: null,
    references: [],
    originalMessageId: null,
    originalGmailMessageId: null,
    attachments: [],
  },
  'plugin:dialog|open': null,
  list_threads: playwrightThreadPage,
  load_conversation: playwrightConversation,
  fetch_message_body: undefined,
  trigger_sync: playwrightTriggerSyncResult,
  read_sync_status: playwrightSyncStatus,
  star_thread: undefined,
  unstar_thread: undefined,
  mark_thread_read: undefined,
  mark_thread_unread: undefined,
  mutate_threads: playwrightMutationResults,
  mutate_messages: undefined,
  delete_draft: undefined,
  create_label: playwrightCreatedLabel,
  rename_label: playwrightCreatedLabel,
  recolor_label: playwrightCreatedLabel,
  delete_label: undefined,
  read_traversal_status: playwrightTraversalStatus,
  // A real avatar-cache path so `dispatchConvertFileSrc`'s Playwright branch
  // (which matches on the `avatar-cache` marker — see `dispatch.ts`) resolves
  // it to the fixture mark instead of falling through to the grey-square
  // placeholder. Every `playwrightThreads` sender shares the `example.com`
  // domain (see `threads.ts`), and this fixture map has one static value per
  // command, so this single path is what every row's sender-avatar query
  // resolves to — enough for Phase 3's plate/ring dark-theme baseline.
  read_sender_avatar: 'avatar-cache/senders/example-com.png',
  read_account_avatar: 'avatar-cache/accounts/account-1.png',
};

export { playwrightSidebarAccounts };
