"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.IPC_EVENTS = exports.IPC_CHANNELS = void 0;
exports.ipcSuccess = ipcSuccess;
exports.ipcError = ipcError;
// IPC Channel constants
// Renderer → Main (invoke/handle, Promise-based)
exports.IPC_CHANNELS = {
    // Mail operations
    MAIL_FETCH_EMAILS: 'mail:fetch-emails',
    MAIL_FETCH_THREAD: 'mail:fetch-thread',
    MAIL_SEND: 'mail:send',
    MAIL_MOVE: 'mail:move',
    MAIL_FLAG: 'mail:flag',
    MAIL_SEARCH: 'mail:search',
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
    // Database/settings operations
    DB_GET_SETTINGS: 'db:get-settings',
    DB_SET_SETTINGS: 'db:set-settings',
    // System operations
    SYSTEM_MINIMIZE: 'system:minimize',
    SYSTEM_MAXIMIZE: 'system:maximize',
    SYSTEM_CLOSE: 'system:close',
    SYSTEM_IS_MAXIMIZED: 'system:is-maximized',
    SYSTEM_GET_PLATFORM: 'system:get-platform',
};
// Main → Renderer (push events)
exports.IPC_EVENTS = {
    MAIL_SYNC: 'mail:sync',
    AUTH_REFRESH: 'auth:refresh',
    AI_STATUS: 'ai:status',
    AI_STREAM: 'ai:stream',
    SYSTEM_NOTIFICATION: 'system:notification',
    SYSTEM_TRAY_ACTION: 'system:tray-action',
};
function ipcSuccess(data) {
    return { success: true, data };
}
function ipcError(code, message) {
    return { success: false, error: { code, message } };
}
//# sourceMappingURL=ipc-channels.js.map