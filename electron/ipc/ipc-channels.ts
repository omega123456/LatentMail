// IPC Channel constants
// Renderer → Main (invoke/handle, Promise-based)
export const IPC_CHANNELS = {
  // Mail operations
  MAIL_FETCH_EMAILS: 'mail:fetch-emails',
  MAIL_FETCH_THREAD: 'mail:fetch-thread',
  MAIL_SEND: 'mail:send',
  MAIL_MOVE: 'mail:move',
  MAIL_FLAG: 'mail:flag',
  MAIL_DELETE: 'mail:delete',
  MAIL_SEARCH: 'mail:search',
  MAIL_SEARCH_IMAP: 'mail:search-imap',
  MAIL_SYNC_ACCOUNT: 'mail:sync-account',
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
  DB_GET_FILTERS: 'db:get-filters',
  DB_SAVE_FILTER: 'db:save-filter',
  DB_UPDATE_FILTER: 'db:update-filter',
  DB_DELETE_FILTER: 'db:delete-filter',
  DB_TOGGLE_FILTER: 'db:toggle-filter',
  DB_GET_USER_LABELS: 'db:get-user-labels',

  // Filter operations
  FILTER_APPLY_ALL: 'filter:apply-all',

  // System operations
  SYSTEM_MINIMIZE: 'system:minimize',
  SYSTEM_MAXIMIZE: 'system:maximize',
  SYSTEM_CLOSE: 'system:close',
  SYSTEM_IS_MAXIMIZED: 'system:is-maximized',
  SYSTEM_GET_PLATFORM: 'system:get-platform',
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
  SYSTEM_NOTIFICATION: 'system:notification',
  SYSTEM_TRAY_ACTION: 'system:tray-action',
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
