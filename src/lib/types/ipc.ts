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
  trigger_sync: { args: { accountId: string }; result: SyncStatus };
  read_sync_status: { args: { accountId: string }; result: SyncStatus };
  star_thread: { args: { accountId: string; threadId: string }; result: void };
  unstar_thread: { args: { accountId: string; threadId: string }; result: void };
  mark_thread_read: { args: { accountId: string; threadId: string }; result: void };
  mark_thread_unread: { args: { accountId: string; threadId: string }; result: void };
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
  syncIntervalMinutes: number;
}

export type SettingKey = keyof Settings;
export type SettingValue = Settings[SettingKey];

export interface MailLabel {
  id: string;
  name: string;
  kind: string;
  color: string | null;
  messageCount: number;
  unreadCount: number;
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
  subject: string;
  sentAt: number;
  snippet: string;
  htmlBody: string | null;
  plainBody: string | null;
  hasAttachments: boolean;
  isUnread: boolean;
  isStarred: boolean;
  labelIds: string[];
  remoteImagesBlocked: boolean;
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
}

export interface NewMailEvent {
  accountId: string;
  threadIds: string[];
}

export interface IpcEventMap {
  'system://health': { status: 'ok' };
  'queue://item': { id: string; status: string };
  'queue://summary': QueueSummary;
  'account://state': Account;
  'sync://progress': SyncProgressEvent;
  'sync://complete': SyncCompleteEvent;
  'mail://new': NewMailEvent;
}
