"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const electron_1 = require("electron");
const electronAPI = {
    // Mail operations
    mail: {
        fetchEmails: (accountId, folderId, options) => electron_1.ipcRenderer.invoke('mail:fetch-emails', accountId, folderId, options),
        fetchThread: (accountId, threadId) => electron_1.ipcRenderer.invoke('mail:fetch-thread', accountId, threadId),
        send: (accountId, message) => electron_1.ipcRenderer.invoke('mail:send', accountId, message),
        move: (accountId, messageIds, targetFolder) => electron_1.ipcRenderer.invoke('mail:move', accountId, messageIds, targetFolder),
        flag: (accountId, messageIds, flag, value) => electron_1.ipcRenderer.invoke('mail:flag', accountId, messageIds, flag, value),
        search: (accountId, query) => electron_1.ipcRenderer.invoke('mail:search', accountId, query),
    },
    // Auth operations
    auth: {
        login: () => electron_1.ipcRenderer.invoke('auth:login'),
        logout: (accountId) => electron_1.ipcRenderer.invoke('auth:logout', accountId),
        getAccounts: () => electron_1.ipcRenderer.invoke('auth:get-accounts'),
    },
    // AI operations
    ai: {
        summarize: (threadContent) => electron_1.ipcRenderer.invoke('ai:summarize', threadContent),
        compose: (prompt, context) => electron_1.ipcRenderer.invoke('ai:compose', prompt, context),
        categorize: (emailContent) => electron_1.ipcRenderer.invoke('ai:categorize', emailContent),
        search: (naturalQuery) => electron_1.ipcRenderer.invoke('ai:search', naturalQuery),
        transform: (text, transformation) => electron_1.ipcRenderer.invoke('ai:transform', text, transformation),
        getModels: () => electron_1.ipcRenderer.invoke('ai:get-models'),
        getStatus: () => electron_1.ipcRenderer.invoke('ai:get-status'),
    },
    // Database/settings operations
    db: {
        getSettings: (keys) => electron_1.ipcRenderer.invoke('db:get-settings', keys),
        setSettings: (settings) => electron_1.ipcRenderer.invoke('db:set-settings', settings),
    },
    // System operations
    system: {
        minimize: () => electron_1.ipcRenderer.invoke('system:minimize'),
        maximize: () => electron_1.ipcRenderer.invoke('system:maximize'),
        close: () => electron_1.ipcRenderer.invoke('system:close'),
        isMaximized: () => electron_1.ipcRenderer.invoke('system:is-maximized'),
        getPlatform: () => electron_1.ipcRenderer.invoke('system:get-platform'),
    },
    // Event listeners (for push events from main process)
    on: (channel, callback) => {
        const validChannels = [
            'mail:sync',
            'auth:refresh',
            'ai:status',
            'ai:stream',
            'system:notification',
            'system:tray-action',
        ];
        if (validChannels.includes(channel)) {
            electron_1.ipcRenderer.on(channel, callback);
        }
    },
    off: (channel, callback) => {
        electron_1.ipcRenderer.removeListener(channel, callback);
    },
};
electron_1.contextBridge.exposeInMainWorld('electronAPI', electronAPI);
//# sourceMappingURL=preload.js.map