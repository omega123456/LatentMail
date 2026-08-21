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
  list_labels: { args: { accountId: string }; result: MailLabel[] };
  lookup_contacts: { args: { accountId: string; query: string }; result: ContactSuggestion[] };
  reply_context: {
    args: {
      accountId: string;
      messageId: string;
      accountEmail: string;
      replyAll: boolean;
      forward: boolean;
      owner: string;
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
  stage_attachment_into_draft: {
    args: { accountId: string; messageId: string; attachmentId: string; owner: string };
    result: StagedAttachment;
  };
  list_threads: {
    args: {
      accountId: string;
      labelId?: string | null;
      cursor?: ThreadCursor | null;
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
      limit?: number | null;
    };
    result: ThreadSearchPage;
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

export interface QueueSummary {
  pending: number;
  active: number;
  failed: number;
  done: number;
  paused: boolean;
  suspended: boolean;
}
export type Lane = 'interactive' | 'background' | 'traversal';

export type OperationKind =
  | 'noop'
  | 'labelMutation'
  | 'send'
  | 'draft'
  | 'sync'
  | 'star'
  | 'unstar'
  | 'markRead'
  | 'markUnread'
  | 'delete'
  | 'move'
  | 'spam'
  | 'notSpam'
  | 'traversal';

export type OperationStatus = 'queued' | 'active' | 'retrying' | 'done' | 'failed' | 'cancelled';

export type LaneState = 'paused' | 'blocked' | 'running' | 'idle';

export interface OperationRecord {
  id: string;
  accountId: string;
  lane: Lane;
  kind: OperationKind;
  description: string;
  status: OperationStatus;
  attempts: number;
  error: string | null;
  retryable: boolean;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface LaneSnapshot {
  lane: Lane;
  capacity: number;
  active: number;
  backlog: number;
  state: LaneState;
  operations: OperationRecord[];
}

export interface AccountQueueSnapshot {
  accountId: string;
  active: number;
  queued: number;
  failed: number;
  lanes: LaneSnapshot[];
}

export type PauseScope =
  | { scope: 'global' }
  | { scope: 'account'; accountId: string }
  | { scope: 'lane'; accountId: string; lane: Lane };

export type ConversationEntryScope =
  { kind: 'mailbox'; mailboxId: string } | { kind: 'search'; scope: SearchScope };

export interface Account {
  id: string;
  email: string;
  displayName: string;
  avatarUrl: string | null;
  needsReauthentication: boolean;
}

export type ThemePreference = 'light' | 'dark' | 'system';
export type LayoutMode = 'three-column' | 'bottom-preview' | 'list-only';
export type Density = 'compact' | 'comfortable' | 'spacious';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type UpdateCheckInterval = '1h' | '5h' | '1d' | '7d' | 'off';

export interface UpdateSummary {
  version: string;
  notes: string | null;
  dateMillis: number | null;
}

export interface UpdateCheckResult {
  currentVersion: string;
  available: UpdateSummary | null;
}

export interface Settings {
  theme: ThemePreference;
  layout: LayoutMode;
  density: Density;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  listWidth: number;
  readerHeight: number;
  syncOnStartup: boolean;
  showUnreadCounts: boolean;
  syncIntervalSeconds: number;
  showSenderAvatars: boolean;
  zoomPercent: number;
  alwaysLoadRemoteImages: boolean;
  allowedImageSenders: string[];
  commandOverrides: Partial<Record<string, string[]>>;
  logLevel: LogLevel;
  prefetchImageAttachments: boolean;
  startAtLogin: boolean;
  closeToTray: boolean;
  startMinimized: boolean;
  desktopNotifications: boolean;
  updateCheckInterval: UpdateCheckInterval;
  installUpdateOnQuit: boolean;
}

export interface LogEntryDto {
  timestampMillis: number;
  level: string;
  message: string;
}

export type SettingKey = keyof Settings;
export type SettingValue = Settings[SettingKey];

export interface MailLabelColor {
  text: string;
  background: string;
}

export interface MailLabel {
  id: string;
  name: string;
  kind: string;
  color: MailLabelColor | null;
  messageCount: number;
  unreadCount: number;
}
export interface ContactSuggestion {
  address: string;
  displayName: string | null;
}
export interface ReplyContext {
  to: string[];
  cc: string[];
  subject: string;
  originalMessageId: string;
  targetThreadId: string | null;
  inReplyTo: string | null;
  references: string[];
  originalGmailMessageId: string;
  displayQuote: { html: string; attribution: string } | null;
  attachments: ReplyContextAttachment[];
}
export interface ReplyContextAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
}
export interface StagedAttachment {
  id: string;
  filename: string;
  mimeType: string;
  path: string;
  contentId: string | null;
  size: number;
}
export interface ComposeDraftRequest {
  sessionId: string;
  accountId: string;
  draftId: string | null;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  mode: string;
  threadId: string | null;
  inReplyTo: string | null;
  references: string[];
  originalMessageId: string | null;
  originalGmailMessageId: string | null;
  quoteHtml: string | null;
  quotePlain: string | null;
  editableBodyFingerprint?: string | null;
  attachments: { id: string; filename: string; mimeType: string; contentId: string | null }[];
}
export interface ComposeQueueAcceptance {
  operationId: string;
  draftId?: string | null;
}
export interface HydratedComposeDraft extends ComposeDraftRequest {
  draftId: string;
  attachments: StagedAttachment[];
  quoteHtml: string | null;
  quotePlain: string | null;
}

export interface DialogOpenOptions {
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
}

export interface DialogSaveOptions {
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export interface CachedAttachmentDto {
  cachePath: string;
  displayPath: string;
  mimeType: string;
  filename: string;
  size: number;
}

export type DragDropEvent =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

export type MoveDestination = 'INBOX' | 'SPAM' | 'TRASH';

export type MutationOutcome = 'applied' | 'superseded';

export interface MutationResult {
  threadId: string;
  outcome: MutationOutcome;
}

export type TraversalKind = 'backfill' | 'reconciliation';

export type TraversalState = 'notStarted' | 'backfilling' | 'reconciling' | 'complete';

export interface TraversalStatus {
  accountId: string;
  state: TraversalState;
  kind: TraversalKind | null;
  discoveredCount: number;
  persistedCount: number;
  lastAdvancedAt: number | null;
  isResumed: boolean;
}

export interface ThreadIdentity {
  display: string;
  address: string | null;
}

export interface MailThread {
  id: string;
  subject: string;
  sender: ThreadIdentity;
  sentRecipient: ThreadIdentity | null;
  latestAt: number;
  messageCount: number;
  isUnread: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  hasDraft: boolean;
  snippet?: string;
  labelIndicators?: string[];
  systemLabelIds?: string[];
}

export interface ThreadCursor {
  latestAt: number;
  id: string;
}

export interface ThreadPage {
  items: MailThread[];
  nextCursor: ThreadCursor | null;
}

export interface ThreadSearchPage {
  items: MailThread[];
  nextCursor: ThreadCursor | null;
  total: number;
}

export type SearchScope =
  { kind: 'default' } | { kind: 'all' } | { kind: 'label'; labelId: string };

export type SearchPredicate =
  | { kind: 'label'; value: string; negated: boolean }
  | { kind: 'unread'; negated: boolean }
  | { kind: 'starred'; negated: boolean }
  | { kind: 'hasAttachment'; negated: boolean }
  | { kind: 'sentBefore'; atSeconds: number; negated: boolean }
  | { kind: 'sentAfter'; atSeconds: number; negated: boolean }
  | { kind: 'textExcludes'; negated: boolean };

export interface ParsedSearchQuery {
  hasTextTerm: boolean;
  from: string | null;
  to: string | null;
  subject: string | null;
  includes: string[];
  excludes: string[];
  predicates: SearchPredicate[];
}

export interface MessageAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  position: number;
}

export interface ConversationMessage {
  id: string;
  sender: string;
  recipients: string[];
  toRecipients?: string[];
  ccRecipients?: string[];
  bccRecipients?: string[];
  subject: string;
  sentAt: number;
  snippet: string;
  htmlBody: string | null;
  htmlPresence: 'neverFetched' | 'present' | 'absent' | 'tooLarge';
  plainBody: string | null;
  hasAttachments: boolean;
  isUnread: boolean;
  isStarred: boolean;
  labelIds: string[];
  remoteImagesBlocked: boolean;
  remoteImagesAllowed: boolean;
  draftId?: string | null;
  truncated: boolean;
  attachments: MessageAttachment[];
}

export interface ImagePolicy {
  alwaysLoad: boolean;
  allowedSenders: string[];
  loadFor: string[];
}

export interface Conversation {
  threadId: string;
  subject: string;
  messages: ConversationMessage[];
}

export type SyncEngineState = 'idle' | 'syncing' | 'error';

export interface SyncStatus {
  accountId: string;
  state: SyncEngineState;
  lastSyncedAt: number | null;
  lastError: string | null;
}

export interface SyncProgressEvent {
  accountId: string;
  state: SyncEngineState;
}

export interface SyncCompleteEvent {
  accountId: string;
  historyId: number;
  addedCount: number;
  changed: boolean;
}

export interface MailArrival {
  threadId: string;
  sender: string;
  subject: string;
}

export interface NewMailEvent {
  accountId: string;
  threadIds: string[];
  arrivals: MailArrival[];
}

export type OsIntent =
  | { kind: 'compose' }
  | { kind: 'syncNow' }
  | { kind: 'openAccounts' }
  | {
      kind: 'mailto';
      mailto: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string };
    }
  | { kind: 'openThread'; accountId: string; threadId: string }
  | { kind: 'openFolder'; accountId: string };

export interface TraversalProgressEvent {
  accountId: string;
  kind: TraversalKind;
  discoveredCount: number;
  persistedCount: number;
  completed: boolean;
}

export interface AvatarResolvedEvent {
  pipeline: 'sender' | 'account';
  key: string;
  resolved: boolean;
}

export interface IpcEventMap {
  'system://health': { status: 'ok' };
  'avatar://resolved': AvatarResolvedEvent;
  'queue://item': { id: string; status: string; accountId: string; lane: Lane };
  'queue://summary': QueueSummary;
  'account://state': Account;
  'sync://progress': SyncProgressEvent;
  'sync://complete': SyncCompleteEvent;
  'mail://new': NewMailEvent;
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
