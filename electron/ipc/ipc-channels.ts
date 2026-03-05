// IPC Channel constants
// Renderer → Main (invoke/handle, Promise-based)
export const IPC_CHANNELS = {
  // Mail operations
  MAIL_FETCH_EMAILS: 'mail:fetch-emails',
  MAIL_FETCH_THREAD: 'mail:fetch-thread',
  MAIL_GET_THREAD_FROM_DB: 'mail:get-thread-from-db',
  MAIL_SEND: 'mail:send',
  MAIL_MOVE: 'mail:move',
  MAIL_FLAG: 'mail:flag',
  MAIL_DELETE: 'mail:delete',
  MAIL_SEARCH_BY_MSGIDS: 'mail:search-by-msgids',
  MAIL_SYNC_ACCOUNT: 'mail:sync-account',
  MAIL_SYNC_FOLDER: 'mail:sync-folder',
  MAIL_GET_FOLDERS: 'mail:get-folders',
  MAIL_FETCH_OLDER: 'mail:fetch-older',

  // Auth operations
  AUTH_LOGIN: 'auth:login',
  AUTH_LOGOUT: 'auth:logout',
  AUTH_GET_ACCOUNTS: 'auth:get-accounts',
  AUTH_GET_ACCOUNT_COUNT: 'auth:get-account-count',

  // AI operations
  AI_SUMMARIZE: 'ai:summarize',
  AI_COMPOSE: 'ai:compose',
  AI_CATEGORIZE: 'ai:categorize',
  AI_SEARCH: 'ai:search',
  AI_TRANSFORM: 'ai:transform',
  AI_GET_MODELS: 'ai:get-models',
  AI_GET_STATUS: 'ai:get-status',
  AI_SET_URL: 'ai:set-url',
  AI_SET_MODEL: 'ai:set-model',
  AI_GENERATE_REPLIES: 'ai:generate-replies',
  AI_GENERATE_FILTER: 'ai:generate-filter',
  AI_DETECT_FOLLOWUP: 'ai:detect-followup',

  // Queue operations
  QUEUE_ENQUEUE: 'queue:enqueue',
  QUEUE_GET_STATUS: 'queue:get-status',
  QUEUE_RETRY_FAILED: 'queue:retry-failed',
  QUEUE_CLEAR_COMPLETED: 'queue:clear-completed',
  QUEUE_CANCEL: 'queue:cancel',
  QUEUE_GET_PENDING_COUNT: 'queue:get-pending-count',

  // Compose operations (signatures & contacts only — draft ops moved to queue)
  COMPOSE_SEARCH_CONTACTS: 'compose:search-contacts',
  COMPOSE_GET_SIGNATURES: 'compose:get-signatures',
  COMPOSE_SAVE_SIGNATURE: 'compose:save-signature',
  COMPOSE_DELETE_SIGNATURE: 'compose:delete-signature',

  // Database/settings operations
  DB_GET_SETTINGS: 'db:get-settings',
  DB_SET_SETTINGS: 'db:set-settings',
  DB_SET_LOG_LEVEL: 'db:set-log-level',
  DB_GET_FILTERS: 'db:get-filters',
  DB_SAVE_FILTER: 'db:save-filter',
  DB_UPDATE_FILTER: 'db:update-filter',
  DB_DELETE_FILTER: 'db:delete-filter',
  DB_TOGGLE_FILTER: 'db:toggle-filter',

  // Filter operations
  FILTER_APPLY_ALL: 'filter:apply-all',

  // Logger operations
  LOGGER_GET_RECENT_ENTRIES: 'logger:get-recent-entries',

  // System operations
  SYSTEM_MINIMIZE: 'system:minimize',
  SYSTEM_MAXIMIZE: 'system:maximize',
  SYSTEM_CLOSE: 'system:close',
  SYSTEM_IS_MAXIMIZED: 'system:is-maximized',
  SYSTEM_GET_PLATFORM: 'system:get-platform',
  SYSTEM_GET_IS_MAC_OS: 'system:get-is-mac-os',
  SYSTEM_SET_ZOOM: 'system:set-zoom',
  SYSTEM_GET_ZOOM: 'system:get-zoom',

  // Attachment operations
  ATTACHMENT_DOWNLOAD: 'attachment:download',
  ATTACHMENT_GET_FOR_EMAIL: 'attachment:get-for-email',
  ATTACHMENT_GET_CONTENT: 'attachment:get-content',
  ATTACHMENT_GET_CONTENT_AS_TEXT: 'attachment:get-content-as-text',
  ATTACHMENT_FETCH_DRAFT_ATTACHMENTS: 'attachment:fetch-draft-attachments',

  // Label CRUD operations
  LABEL_CREATE: 'label:create',
  LABEL_DELETE: 'label:delete',
  LABEL_UPDATE_COLOR: 'label:update-color',

  // BIMI sender avatar (logo from domain BIMI DNS record)
  BIMI_GET_LOGO: 'bimi:get-logo',

  // Sync pause/resume state
  SYNC_GET_PAUSED: 'sync:get-paused',
  SYNC_PAUSE: 'sync:pause',
  SYNC_RESUME: 'sync:resume',

  // Embedding / semantic search operations
  AI_SET_EMBEDDING_MODEL: 'ai:set-embedding-model',
  AI_GET_EMBEDDING_STATUS: 'ai:get-embedding-status',
  AI_BUILD_INDEX: 'ai:build-index',
  AI_CANCEL_INDEX: 'ai:cancel-index',
} as const;

// Main → Renderer (push events)
export const IPC_EVENTS = {
  MAIL_SYNC: 'mail:sync',
  AUTH_REFRESH: 'auth:refresh',
  AI_STATUS: 'ai:status',
  AI_STREAM: 'ai:stream',
  QUEUE_UPDATE: 'queue:update',
  MAIL_FOLDER_UPDATED: 'mail:folder-updated',
  MAIL_NEW_EMAIL: 'mail:new-email',
  MAIL_NOTIFICATION_CLICK: 'mail:notification-click',
  MAIL_THREAD_REFRESH: 'mail:thread-refresh',
  MAIL_FETCH_OLDER_DONE: 'mail:fetch-older-done',
  SYSTEM_NOTIFICATION: 'system:notification',
  SYSTEM_TRAY_ACTION: 'system:tray-action',

  // OS file drag-and-drop (Win32 native addon → renderer)
  OS_FILE_DRAG_ENTER: 'os-file:drag-enter',
  OS_FILE_DRAG_LEAVE: 'os-file:drag-leave',
  OS_FILE_DROP: 'os-file:drop',

  // Embedding / semantic index progress events (main → renderer)
  EMBEDDING_PROGRESS: 'embedding:progress',
  EMBEDDING_COMPLETE: 'embedding:complete',
  EMBEDDING_ERROR: 'embedding:error',
  EMBEDDING_RESUME: 'embedding:resume',

  // AI semantic search streaming events (main → renderer)
  AI_SEARCH_BATCH: 'ai:search:batch',
  AI_SEARCH_COMPLETE: 'ai:search:complete',

  // Sync pause state change (fired when pause-sync / resume-sync CLI command runs)
  SYNC_PAUSED_STATE_CHANGED: 'sync:paused-state-changed',
} as const;

// IPC response envelope
export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export function ipcSuccess<T>(data: T): IpcResponse<T> {
  return { success: true, data };
}

export function ipcError(code: string, message: string): IpcResponse<never> {
  return { success: false, error: { code, message } };
}
