// IPC Channel constants
// Renderer → Main (invoke/handle, Promise-based)
export const IPC_CHANNELS = {
  // Mail operations
  MAIL_FETCH_EMAILS: 'mail:fetch-emails',
  MAIL_FETCH_THREAD: 'mail:fetch-thread',
  MAIL_SEND: 'mail:send',
  MAIL_MOVE: 'mail:move',
  MAIL_FLAG: 'mail:flag',
  MAIL_SEARCH: 'mail:search',
  MAIL_SYNC_ACCOUNT: 'mail:sync-account',
  MAIL_GET_FOLDERS: 'mail:get-folders',

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

  // Compose operations
  COMPOSE_SAVE_DRAFT: 'compose:save-draft',
  COMPOSE_GET_DRAFTS: 'compose:get-drafts',
  COMPOSE_GET_DRAFT: 'compose:get-draft',
  COMPOSE_DELETE_DRAFT: 'compose:delete-draft',
  COMPOSE_DELETE_DRAFT_ON_SERVER: 'compose:delete-draft-on-server',
  COMPOSE_SEARCH_CONTACTS: 'compose:search-contacts',
  COMPOSE_GET_SIGNATURES: 'compose:get-signatures',
  COMPOSE_SAVE_SIGNATURE: 'compose:save-signature',
  COMPOSE_DELETE_SIGNATURE: 'compose:delete-signature',

  // Database/settings operations
  DB_GET_SETTINGS: 'db:get-settings',
  DB_SET_SETTINGS: 'db:set-settings',

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
