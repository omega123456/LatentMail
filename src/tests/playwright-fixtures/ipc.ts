import type { IpcCommandMap } from '@/lib/types/ipc';
import { playwrightSidebarAccounts } from './accounts';
import { playwrightCreatedLabel, playwrightLabels, playwrightMutationResults } from './labels';
import { playwrightThreadPage } from './threads';
import { playwrightConversation, playwrightEmptyMessageBody } from './conversations';
import { playwrightSyncStatus, playwrightTriggerSyncResult } from './sync';
import { playwrightTraversalStatus } from './traversal';
import { playwrightSettings } from './settings';
import { playwrightLogEntries } from './logs';
import {
  playwrightContactSuggestions,
  playwrightHydratedDraft,
  playwrightReplyContext,
  playwrightSavedDraftAcceptance,
  playwrightSentDraftAcceptance,
  playwrightStagedAttachment,
} from './compose';
import {
  playwrightEmptyParsedSearchQuery,
  playwrightEmptySearchPage,
  playwrightZeroSearchTotal,
} from './search';
import { playwrightNoUpdate } from './update';
import { playwrightAccountAvatarPath, playwrightSenderAvatarPath } from './avatars';
import { playwrightCachedAttachment } from './attachments';
import { playwrightMessageSource } from './message-source';
import {
  playwrightPausedQueueSummary,
  playwrightQueueOperationsSnapshot,
  playwrightQueueSummary,
  playwrightResumedQueueSummary,
} from './queue';
import { playwrightAiConfigs, playwrightAiIndexStatuses, playwrightAiModels } from './ai';
import { playwrightAiChatRequestId } from './ai-chat';

export const playwrightIpcFixtures: { [C in keyof IpcCommandMap]: IpcCommandMap[C]['result'] } = {
  health_check: { status: 'ok' },
  open_external_url: undefined,
  write_frontend_log: undefined,
  read_settings: playwrightSettings,
  write_setting: undefined,
  read_log_entries: playwrightLogEntries,
  pause_queue: playwrightPausedQueueSummary,
  resume_queue: playwrightResumedQueueSummary,
  read_queue_summary: playwrightQueueSummary,
  list_accounts: [],
  begin_sign_in: undefined,
  begin_reauthentication: undefined,
  remove_account: undefined,
  read_ai_configs: playwrightAiConfigs,
  set_ai_enabled: undefined,
  set_ai_base_url: undefined,
  set_ai_api_key: undefined,
  clear_ai_api_key: undefined,
  test_ai_connection: 0,
  list_ai_models: playwrightAiModels,
  select_ai_chat_model: undefined,
  select_ai_embedding_model: undefined,
  read_ai_index_status: playwrightAiIndexStatuses,
  start_ai_index: undefined,
  cancel_ai_index: undefined,
  rebuild_ai_index: undefined,
  start_ai_chat: playwrightAiChatRequestId,
  cancel_ai_chat: false,
  list_labels: playwrightLabels,
  lookup_contacts: playwrightContactSuggestions,
  reply_context: playwrightReplyContext,
  stage_attachment_from_path: playwrightStagedAttachment,
  stage_attachment_from_bytes: playwrightStagedAttachment,
  stage_attachment_into_draft: playwrightStagedAttachment,
  release_staged_attachment: undefined,
  save_compose_draft: playwrightSavedDraftAcceptance,
  send_compose_draft: playwrightSentDraftAcceptance,
  discard_compose_draft: undefined,
  hydrate_compose_draft: playwrightHydratedDraft,
  'plugin:dialog|open': null,
  'plugin:dialog|save': null,
  ensure_attachment_cached: playwrightCachedAttachment,
  read_attachment_bytes: new ArrayBuffer(0),
  read_attachment_text: '',
  save_attachment_to_path: undefined,
  read_message_source: playwrightMessageSource,
  save_message_source_to_path: undefined,
  save_message_html_to_path: undefined,
  list_threads: playwrightThreadPage,
  load_conversation: playwrightConversation,
  load_message_body: playwrightEmptyMessageBody,
  fetch_message_body: undefined,
  trigger_sync: playwrightTriggerSyncResult,
  read_sync_status: playwrightSyncStatus,
  star_thread: undefined,
  unstar_thread: undefined,
  mark_thread_read: undefined,
  mark_thread_unread: undefined,
  mutate_threads: playwrightMutationResults,
  mutate_messages: undefined,
  delete_threads: playwrightMutationResults,
  move_threads: playwrightMutationResults,
  delete_messages: undefined,
  move_messages: undefined,
  delete_draft: undefined,
  create_label: playwrightCreatedLabel,
  rename_label: playwrightCreatedLabel,
  recolor_label: playwrightCreatedLabel,
  delete_label: undefined,
  read_traversal_status: playwrightTraversalStatus,
  read_sender_avatar: playwrightSenderAvatarPath,
  read_account_avatar: playwrightAccountAvatarPath,
  search_threads: playwrightEmptySearchPage,
  search_total: playwrightZeroSearchTotal,
  parse_search_query: playwrightEmptyParsedSearchQuery,
  read_queue_operations: playwrightQueueOperationsSnapshot,
  cancel_queue_operation: true,
  retry_queue_operation: true,
  retry_failed_operations: 0,
  clear_queue_history: undefined,
  set_queue_paused: true,
  check_for_update: playwrightNoUpdate,
  install_update: undefined,
};

export { playwrightSidebarAccounts };
