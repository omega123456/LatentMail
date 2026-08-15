export interface IpcCommandMap {
  health_check: { args: Record<string, never>; result: { status: 'ok' } };
  open_external_url: { args: { url: string }; result: void };
  write_frontend_log: {
    args: { level: 'debug' | 'info' | 'warn' | 'error'; message: string };
    result: void;
  };
  read_settings: { args: Record<string, never>; result: Settings };
  write_setting: { args: { key: SettingKey; value: SettingValue }; result: void };
  pause_queue: { args: Record<string, never>; result: QueueSummary };
  resume_queue: { args: Record<string, never>; result: QueueSummary };
  read_queue_summary: { args: Record<string, never>; result: QueueSummary };
  list_accounts: { args: Record<string, never>; result: Account[] };
  begin_sign_in: { args: Record<string, never>; result: void };
  begin_reauthentication: { args: { accountId: string }; result: void };
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
  /** The Tauri dialog plugin's own wire contract (`invoke('plugin:dialog|open', { options })`)
   * — not a Rust command owned by this app, but routed through the same
   * generic `invoke` and mockable the same way (per CLAUDE.md's "one
   * generic invoke function keyed on IpcCommandMap" rule) rather than a
   * bespoke per-command wrapper. */
  'plugin:dialog|open': {
    args: { options: DialogOpenOptions };
    result: string | string[] | null;
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
    args: { accountId: string; threadId: string };
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
}

export interface QueueSummary {
  pending: number;
  active: number;
  failed: number;
  done: number;
  paused: boolean;
}
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
}

export type SettingKey = keyof Settings;
export type SettingValue = Settings[SettingKey];

/** A label's real Gmail text/background colour pair (D10) — replaces the
 * fabricated 3-colour cycle `mappers.ts` used to apply client-side. Present
 * only on user labels. */
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

/** The subset of `@tauri-apps/plugin-dialog`'s `OpenDialogOptions` this app
 * actually passes — kept local rather than importing the plugin's own type
 * so `IpcCommandMap` doesn't force a hard dependency edge onto every
 * consumer of this file. */
export interface DialogOpenOptions {
  multiple?: boolean;
  directory?: boolean;
  filters?: { name: string; extensions: string[] }[];
}

/** Mirrors `@tauri-apps/api/webview`'s `DragDropEvent` union — this app's
 * only native drag-drop consumer (`src/lib/compose/file-drop.ts`). Declared
 * locally for the same reason as `DialogOpenOptions` above. */
export type DragDropEvent =
  | { type: 'enter'; paths: string[]; position: { x: number; y: number } }
  | { type: 'over'; position: { x: number; y: number } }
  | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
  | { type: 'leave' };

export type MutationOutcome = 'applied' | 'superseded';

export interface MutationResult {
  threadId: string;
  outcome: MutationOutcome;
}

export type TraversalKind = 'backfill' | 'reconciliation';

/** D11: always a count, never a percentage or estimate. */
export type TraversalState = 'notStarted' | 'backfilling' | 'reconciling' | 'complete';

export interface TraversalStatus {
  accountId: string;
  state: TraversalState;
  kind: TraversalKind | null;
  discoveredCount: number;
  persistedCount: number;
  lastAdvancedAt: number | null;
  /** True when the traversal is continuing from a saved checkpoint rather
   * than starting fresh from the first page. */
  isResumed: boolean;
}

export interface MailThread {
  id: string;
  subject: string;
  participants: string[];
  latestAt: number;
  messageCount: number;
  isUnread: boolean;
  isStarred: boolean;
  hasAttachments: boolean;
  hasDraft: boolean;
  snippet?: string;
  labelIndicators?: string[];
}

export interface ThreadCursor {
  latestAt: number;
  id: string;
}

export interface ThreadPage {
  items: MailThread[];
  nextCursor: ThreadCursor | null;
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
  htmlPresence: 'neverFetched' | 'present' | 'absent';
  plainBody: string | null;
  hasAttachments: boolean;
  isUnread: boolean;
  isStarred: boolean;
  labelIds: string[];
  remoteImagesBlocked: boolean;
  draftId?: string | null;
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

/** One newly arrived, still-unread Inbox message. Only the incremental
 * (poll) sync fills these in — a full sync reports the whole mailbox as
 * "added" and must never raise notifications for it. */
export interface MailArrival {
  sender: string;
  subject: string;
}

export interface NewMailEvent {
  accountId: string;
  threadIds: string[];
  arrivals: MailArrival[];
}

export interface TraversalProgressEvent {
  accountId: string;
  kind: TraversalKind;
  discoveredCount: number;
  persistedCount: number;
  completed: boolean;
}

export interface IpcEventMap {
  'system://health': { status: 'ok' };
  'queue://item': { id: string; status: string };
  'queue://summary': QueueSummary;
  'account://state': Account;
  'sync://progress': SyncProgressEvent;
  'sync://complete': SyncCompleteEvent;
  'mail://new': NewMailEvent;
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
  /** Synthetic channel key the shared test harness (`src/tests/ipc-mock.ts`)
   * uses to fan out `getCurrentWebview().onDragDropEvent` callbacks through
   * the same `ipc.emit` semantics every other event uses — this key is never
   * a real Tauri event name (drag-drop is delivered through the Webview
   * API, not `@tauri-apps/api/event`), it exists purely as the harness's
   * addressable channel for it. */
  'tauri://drag-drop': DragDropEvent;
}
