import type { Account, AiChatEvent, AiConfig, AiIndexStatus, AiModel } from './ipc/account-ai';
import type {
  CachedAttachmentDto,
  ComposeDraftRequest,
  ComposeQueueAcceptance,
  ContactSuggestion,
  HydratedComposeDraft,
  ReplyContext,
  StagedAttachment,
} from './ipc/compose';
import type {
  Conversation,
  ConversationEntryScope,
  ImagePolicy,
  MailLabel,
  MessageBody,
  MessageSource,
  MoveDestination,
  MutationResult,
  ParsedSearchQuery,
  SearchScope,
  ThreadCursor,
  ThreadPage,
  ThreadPageDirection,
  ThreadSearchPage,
} from './ipc/mail';
import type { AccountQueueSnapshot, Lane, PauseScope, QueueSummary } from './ipc/queue';
import type {
  DialogOpenOptions,
  DialogSaveOptions,
  DragDropEvent,
  LogEntryDto,
  OsIntent,
  SettingKey,
  Settings,
  SettingValue,
  UpdateCheckResult,
} from './ipc/settings';
import type {
  AvatarResolvedEvent,
  NewMailEvent,
  SyncCompleteEvent,
  SyncProgressEvent,
  SyncStatus,
  TraversalProgressEvent,
  TraversalStatus,
} from './ipc/sync';

export * from './ipc/account-ai';
export * from './ipc/compose';
export * from './ipc/mail';
export * from './ipc/queue';
export * from './ipc/settings';
export * from './ipc/sync';

export interface IpcCommandMap {
  health_check: { args: Record<string, never>; result: { status: 'ok' } };
  open_external_url: { args: { url: string }; result: void };
  write_frontend_log: {
    args: { level: 'debug' | 'info' | 'warn' | 'error'; message: string };
    result: void;
  };
  read_settings: { args: Record<string, never>; result: Settings };
  write_setting: { args: { key: SettingKey; value: SettingValue }; result: void };
  read_log_entries: { args: Record<string, never>; result: LogEntryDto[] };
  pause_queue: { args: Record<string, never>; result: QueueSummary };
  resume_queue: { args: Record<string, never>; result: QueueSummary };
  read_queue_summary: { args: Record<string, never>; result: QueueSummary };
  list_accounts: { args: Record<string, never>; result: Account[] };
  begin_sign_in: { args: Record<string, never>; result: void };
  begin_reauthentication: { args: { accountId: string }; result: void };
  remove_account: { args: { accountId: string }; result: void };
  read_ai_configs: { args: Record<string, never>; result: AiConfig[] };
  set_ai_enabled: { args: { accountId: string; enabled: boolean }; result: void };
  set_ai_base_url: { args: { accountId: string; baseUrl: string }; result: void };
  set_ai_api_key: { args: { accountId: string; apiKey: string }; result: void };
  clear_ai_api_key: { args: { accountId: string }; result: void };
  test_ai_connection: { args: { accountId: string }; result: number };
  list_ai_models: { args: { accountId: string }; result: AiModel[] };
  select_ai_chat_model: { args: { accountId: string; model: string | null }; result: void };
  select_ai_embedding_model: { args: { accountId: string; model: string }; result: void };
  read_ai_index_status: { args: Record<string, never>; result: AiIndexStatus[] };
  start_ai_index: { args: { accountId: string }; result: void };
  cancel_ai_index: { args: { accountId: string }; result: void };
  rebuild_ai_index: { args: { accountId: string }; result: void };
  start_ai_chat: {
    args: { accountId: string; sessionId: string; question: string };
    result: string;
  };
  cancel_ai_chat: { args: { requestId: string }; result: boolean };
  list_labels: { args: { accountId: string }; result: MailLabel[] };
  lookup_contacts: { args: { accountId: string; query: string }; result: ContactSuggestion[] };
  reply_context: {
    args: {
      accountId: string;
      messageId: string;
      accountEmail: string;
      replyAll: boolean;
      forward: boolean;
    };
    result: ReplyContext;
  };
  stage_attachment_from_path: {
    args: {
      accountId: string;
      owner: string;
      path: string;
      mimeType: string;
      contentId?: string | null;
    };
    result: StagedAttachment;
  };
  stage_attachment_from_bytes: {
    args: {
      accountId: string;
      owner: string;
      filename: string;
      mimeType: string;
      contentId?: string | null;
      bytes: number[];
    };
    result: StagedAttachment;
  };
  release_staged_attachment: {
    args: { accountId: string; owner: string; id: string };
    result: void;
  };
  save_compose_draft: { args: { draft: ComposeDraftRequest }; result: ComposeQueueAcceptance };
  send_compose_draft: { args: { draft: ComposeDraftRequest }; result: ComposeQueueAcceptance };
  discard_compose_draft: {
    args: { accountId: string; draftId: string | null; sessionId: string };
    result: void;
  };
  hydrate_compose_draft: {
    args: { accountId: string; draftId: string };
    result: HydratedComposeDraft;
  };
  'plugin:dialog|open': {
    args: { options: DialogOpenOptions };
    result: string | string[] | null;
  };
  'plugin:dialog|save': {
    args: { options: DialogSaveOptions };
    result: string | null;
  };
  ensure_attachment_cached: {
    args: { accountId: string; messageId: string; attachmentId: string };
    result: CachedAttachmentDto;
  };
  read_attachment_bytes: {
    args: { accountId: string; messageId: string; attachmentId: string };
    result: ArrayBuffer;
  };
  read_attachment_text: {
    args: { accountId: string; messageId: string; attachmentId: string };
    result: string;
  };
  save_attachment_to_path: {
    args: { accountId: string; messageId: string; attachmentId: string; destination: string };
    result: void;
  };
  read_message_source: { args: { accountId: string; messageId: string }; result: MessageSource };
  save_message_source_to_path: {
    args: { accountId: string; messageId: string; destination: string };
    result: void;
  };
  save_message_html_to_path: {
    args: { accountId: string; messageId: string; destination: string };
    result: void;
  };
  stage_attachment_into_draft: {
    args: { accountId: string; messageId: string; attachmentId: string; owner: string };
    result: StagedAttachment;
  };
  list_threads: {
    args: {
      accountId: string;
      labelId?: string | null;
      cursor?: ThreadCursor | null;
      direction?: ThreadPageDirection | null;
      limit?: number | null;
    };
    result: ThreadPage;
  };
  load_conversation: {
    args: {
      accountId: string;
      threadId: string;
      imagePolicy: ImagePolicy;
      entryScope?: ConversationEntryScope;
    };
    result: Conversation;
  };
  load_message_body: {
    args: {
      accountId: string;
      messageId: string;
      imagePolicy: ImagePolicy;
      entryScope?: ConversationEntryScope;
    };
    result: MessageBody;
  };
  fetch_message_body: { args: { accountId: string; messageId: string }; result: void };
  trigger_sync: { args: { accountId: string }; result: SyncStatus };
  read_sync_status: { args: { accountId: string }; result: SyncStatus };
  star_thread: { args: { accountId: string; threadId: string }; result: void };
  unstar_thread: { args: { accountId: string; threadId: string }; result: void };
  mark_thread_read: { args: { accountId: string; threadId: string }; result: void };
  mark_thread_unread: { args: { accountId: string; threadId: string }; result: void };
  mutate_threads: {
    args: { accountId: string; threadIds: string[]; add: string[]; remove: string[] };
    result: MutationResult[];
  };
  mutate_messages: {
    args: { accountId: string; messageIds: string[]; add: string[]; remove: string[] };
    result: void;
  };
  delete_threads: {
    args: { accountId: string; threadIds: string[] };
    result: MutationResult[];
  };
  move_threads: {
    args: { accountId: string; threadIds: string[]; destination: MoveDestination };
    result: MutationResult[];
  };
  delete_messages: {
    args: { accountId: string; messageIds: string[] };
    result: void;
  };
  move_messages: {
    args: { accountId: string; messageIds: string[]; destination: MoveDestination };
    result: void;
  };
  delete_draft: { args: { accountId: string; messageId: string }; result: void };
  create_label: {
    args: { accountId: string; name: string; colorId?: string | null };
    result: MailLabel;
  };
  rename_label: {
    args: { accountId: string; labelId: string; name: string };
    result: MailLabel;
  };
  recolor_label: {
    args: { accountId: string; labelId: string; colorId: string };
    result: MailLabel;
  };
  delete_label: { args: { accountId: string; labelId: string }; result: void };
  read_traversal_status: { args: { accountId: string }; result: TraversalStatus };
  read_sender_avatar: { args: { domain: string }; result: string | null };
  read_account_avatar: { args: { accountId: string }; result: string | null };
  search_threads: {
    args: {
      accountId: string;
      query: string;
      scope?: SearchScope | null;
      cursor?: ThreadCursor | null;
      direction?: ThreadPageDirection | null;
      limit?: number | null;
    };
    result: ThreadSearchPage;
  };
  search_total: {
    args: { accountId: string; query: string; scope?: SearchScope | null };
    result: number;
  };
  parse_search_query: { args: { query: string }; result: ParsedSearchQuery };
  read_queue_operations: { args: Record<string, never>; result: AccountQueueSnapshot[] };
  cancel_queue_operation: { args: { operationId: string }; result: boolean };
  retry_queue_operation: { args: { operationId: string }; result: boolean };
  retry_failed_operations: { args: { accountId?: string | null }; result: number };
  clear_queue_history: { args: { accountId?: string | null }; result: void };
  set_queue_paused: { args: { scope: PauseScope; paused: boolean }; result: boolean };
  check_for_update: { args: Record<string, never>; result: UpdateCheckResult };
  install_update: { args: Record<string, never>; result: void };
}

export interface IpcEventMap {
  'avatar://resolved': AvatarResolvedEvent;
  'queue://item': { id: string; status: string; accountId: string; lane: Lane };
  'ai://index': {
    accountId: string;
    indexed: number;
    total: number;
    indexedMessages: number;
    totalEligibleMessages: number;
    indexedPassages: number;
    state: AiIndexStatus['state'];
    paused: boolean;
    error: string | null;
  };
  'queue://summary': QueueSummary;
  'account://state': Account;
  'account://removed': { accountId: string };
  'mail://changed': { accountId: string };
  'ai://config': { accountId: string; removed?: boolean };
  'ai-chat://event': AiChatEvent;
  'sync://progress': SyncProgressEvent;
  'sync://complete': SyncCompleteEvent;
  'mail://new': NewMailEvent;
  'message://body-fetched': { accountId: string; messageId: string };
  'os://intent': OsIntent;
  'sync://traversal': TraversalProgressEvent;
  'send://uncertain': { accountId: string };
  'draft://saved': { accountId: string; sessionId: string; draftId: string };
  'send://complete': { accountId: string; sessionId: string; draftId: string };
  'compose://failed': {
    accountId: string;
    sessionId: string;
    kind: 'send' | 'draft';
    error: string;
  };
  'tauri://drag-drop': DragDropEvent;
}
