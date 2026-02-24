import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

export interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

type IpcCallback = (event: IpcRendererEvent, ...args: unknown[]) => void;

const electronAPI = {
  // Mail operations
  mail: {
    fetchEmails: (accountId: string, folderId: string, options?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('mail:fetch-emails', accountId, folderId, options) as Promise<IpcResponse>,
    fetchThread: (accountId: string, threadId: string, forceFromServer?: boolean) =>
      ipcRenderer.invoke('mail:fetch-thread', accountId, threadId, forceFromServer) as Promise<IpcResponse>,
    getThreadFromDb: (accountId: string, threadId: string, folderId?: string) =>
      ipcRenderer.invoke('mail:get-thread-from-db', accountId, threadId, folderId) as Promise<IpcResponse>,
    send: (accountId: string, message: unknown) =>
      ipcRenderer.invoke('mail:send', accountId, message) as Promise<IpcResponse>,
    move: (accountId: string, messageIds: string[], targetFolder: string, sourceFolder?: string) =>
      ipcRenderer.invoke('mail:move', accountId, messageIds, targetFolder, sourceFolder) as Promise<IpcResponse>,
    flag: (accountId: string, messageIds: string[], flag: string, value: boolean) =>
      ipcRenderer.invoke('mail:flag', accountId, messageIds, flag, value) as Promise<IpcResponse>,
    delete: (accountId: string, messageIds: string[], folder: string) =>
      ipcRenderer.invoke('mail:delete', accountId, messageIds, folder) as Promise<IpcResponse>,
    search: (accountId: string, query: string | string[]) =>
      ipcRenderer.invoke('mail:search', accountId, query) as Promise<IpcResponse>,
    searchImap: (accountId: string, query: string | string[]) =>
      ipcRenderer.invoke('mail:search-imap', accountId, query) as Promise<IpcResponse>,
    syncAccount: (accountId: string) =>
      ipcRenderer.invoke('mail:sync-account', accountId) as Promise<IpcResponse>,
    getFolders: (accountId: string) =>
      ipcRenderer.invoke('mail:get-folders', accountId) as Promise<IpcResponse>,
    fetchOlderEmails: (accountId: string, folderId: string, beforeDate: string, limit: number) =>
      ipcRenderer.invoke('mail:fetch-older', accountId, folderId, beforeDate, limit) as Promise<IpcResponse>,
  },

  // Auth operations
  auth: {
    login: () =>
      ipcRenderer.invoke('auth:login') as Promise<IpcResponse>,
    logout: (accountId: string) =>
      ipcRenderer.invoke('auth:logout', accountId) as Promise<IpcResponse>,
    getAccounts: () =>
      ipcRenderer.invoke('auth:get-accounts') as Promise<IpcResponse>,
    getAccountCount: () =>
      ipcRenderer.invoke('auth:get-account-count') as Promise<IpcResponse>,
  },

  // AI operations
  ai: {
    summarize: (threadContent: string, requestId?: string) =>
      ipcRenderer.invoke('ai:summarize', threadContent, requestId) as Promise<IpcResponse>,
    compose: (prompt: string, context?: string, requestId?: string) =>
      ipcRenderer.invoke('ai:compose', prompt, context, requestId) as Promise<IpcResponse>,
    categorize: (emailContent: string) =>
      ipcRenderer.invoke('ai:categorize', emailContent) as Promise<IpcResponse>,
    search: (accountId: string, naturalQuery: string, folders?: string[]) =>
      ipcRenderer.invoke('ai:search', accountId, naturalQuery, folders) as Promise<IpcResponse>,
    transform: (text: string, transformation: string, requestId?: string) =>
      ipcRenderer.invoke('ai:transform', text, transformation, requestId) as Promise<IpcResponse>,
    getModels: () =>
      ipcRenderer.invoke('ai:get-models') as Promise<IpcResponse>,
    getStatus: () =>
      ipcRenderer.invoke('ai:get-status') as Promise<IpcResponse>,
    setUrl: (url: string) =>
      ipcRenderer.invoke('ai:set-url', url) as Promise<IpcResponse>,
    setModel: (model: string) =>
      ipcRenderer.invoke('ai:set-model', model) as Promise<IpcResponse>,
    generateReplies: (threadContent: string) =>
      ipcRenderer.invoke('ai:generate-replies', threadContent) as Promise<IpcResponse>,
    generateFilter: (description: string, accountId: number) =>
      ipcRenderer.invoke('ai:generate-filter', description, accountId) as Promise<IpcResponse>,
    detectFollowUp: (emailContent: string) =>
      ipcRenderer.invoke('ai:detect-followup', emailContent) as Promise<IpcResponse>,
  },

  // Compose operations (signatures & contacts only — draft ops moved to queue)
  compose: {
    searchContacts: (query: string) =>
      ipcRenderer.invoke('compose:search-contacts', query) as Promise<IpcResponse>,
    getSignatures: () =>
      ipcRenderer.invoke('compose:get-signatures') as Promise<IpcResponse>,
    saveSignatures: (signatures: unknown) =>
      ipcRenderer.invoke('compose:save-signature', signatures) as Promise<IpcResponse>,
    deleteSignature: (signatureId: string) =>
      ipcRenderer.invoke('compose:delete-signature', signatureId) as Promise<IpcResponse>,
  },

  // Queue operations
  queue: {
    enqueue: (operation: unknown) =>
      ipcRenderer.invoke('queue:enqueue', operation) as Promise<IpcResponse>,
    getStatus: () =>
      ipcRenderer.invoke('queue:get-status') as Promise<IpcResponse>,
    retryFailed: (params?: { queueId?: string }) =>
      ipcRenderer.invoke('queue:retry-failed', params) as Promise<IpcResponse>,
    clearCompleted: () =>
      ipcRenderer.invoke('queue:clear-completed') as Promise<IpcResponse>,
    cancel: (params: { queueId: string }) =>
      ipcRenderer.invoke('queue:cancel', params) as Promise<IpcResponse>,
    getPendingCount: () =>
      ipcRenderer.invoke('queue:get-pending-count') as Promise<IpcResponse>,
  },

  // Database/settings operations
  db: {
    getSettings: (keys?: string[]) =>
      ipcRenderer.invoke('db:get-settings', keys) as Promise<IpcResponse>,
    setSettings: (settings: Record<string, string>) =>
      ipcRenderer.invoke('db:set-settings', settings) as Promise<IpcResponse>,
    getFilters: (accountId: number) =>
      ipcRenderer.invoke('db:get-filters', accountId) as Promise<IpcResponse>,
    saveFilter: (filter: unknown) =>
      ipcRenderer.invoke('db:save-filter', filter) as Promise<IpcResponse>,
    updateFilter: (filter: unknown) =>
      ipcRenderer.invoke('db:update-filter', filter) as Promise<IpcResponse>,
    deleteFilter: (filterId: number) =>
      ipcRenderer.invoke('db:delete-filter', filterId) as Promise<IpcResponse>,
    toggleFilter: (filterId: number, isEnabled: boolean) =>
      ipcRenderer.invoke('db:toggle-filter', filterId, isEnabled) as Promise<IpcResponse>,
    setLogLevel: (level: string) =>
      ipcRenderer.invoke('db:set-log-level', level) as Promise<IpcResponse>,
  },

  // Filter operations
  filter: {
    applyAll: (accountId: number) =>
      ipcRenderer.invoke('filter:apply-all', accountId) as Promise<IpcResponse>,
  },

  // Logger operations
  logger: {
    getRecentEntries: () =>
      ipcRenderer.invoke('logger:get-recent-entries') as Promise<IpcResponse>,
  },

  // System operations
  system: {
    minimize: () => ipcRenderer.invoke('system:minimize') as Promise<void>,
    maximize: () => ipcRenderer.invoke('system:maximize') as Promise<void>,
    close: () => ipcRenderer.invoke('system:close') as Promise<void>,
    isMaximized: () => ipcRenderer.invoke('system:is-maximized') as Promise<boolean>,
    getPlatform: () => ipcRenderer.invoke('system:get-platform') as Promise<string>,
  },

  // Attachment operations
  attachments: {
    getForEmail: (accountId: string, xGmMsgId: string) =>
      ipcRenderer.invoke('attachment:get-for-email', accountId, xGmMsgId) as Promise<IpcResponse>,
    getContent: (attachmentId: number) =>
      ipcRenderer.invoke('attachment:get-content', attachmentId) as Promise<IpcResponse>,
    getContentAsText: (attachmentId: number) =>
      ipcRenderer.invoke('attachment:get-content-as-text', attachmentId) as Promise<IpcResponse>,
    download: (attachmentId: number) =>
      ipcRenderer.invoke('attachment:download', attachmentId) as Promise<IpcResponse>,
    fetchDraftAttachments: (accountId: string, xGmMsgId: string) =>
      ipcRenderer.invoke('attachment:fetch-draft-attachments', accountId, xGmMsgId) as Promise<IpcResponse>,
  },

  // Label CRUD operations
  labels: {
    create: (accountId: string, name: string, color: string | null) =>
      ipcRenderer.invoke('label:create', accountId, name, color) as Promise<IpcResponse>,
    delete: (accountId: string, gmailLabelId: string) =>
      ipcRenderer.invoke('label:delete', accountId, gmailLabelId) as Promise<IpcResponse>,
    updateColor: (accountId: string, gmailLabelId: string, color: string | null) =>
      ipcRenderer.invoke('label:update-color', accountId, gmailLabelId, color) as Promise<IpcResponse>,
  },

  // Gravatar (main-process check so 404s don't log in renderer console)
  gravatar: {
    check: (url: string) => ipcRenderer.invoke('gravatar:check', url) as Promise<IpcResponse>,
  },

  // Event listeners (for push events from main process)
  on: (channel: string, callback: IpcCallback) => {
    const validChannels = [
      'mail:sync',
      'auth:refresh',
      'ai:status',
      'ai:stream',
      'queue:update',
      'mail:folder-updated',
      'mail:new-email',
      'mail:notification-click',
      'mail:thread-refresh',
      'mail:fetch-older-done',
      'system:notification',
      'system:tray-action',
      // OS file drag-and-drop (Win32 native addon — canonical defs in ipc-channels.ts)
      'os-file:drag-enter',
      'os-file:drag-leave',
      'os-file:drop',
    ];
    if (validChannels.includes(channel)) {
      ipcRenderer.on(channel, callback);
    }
  },

  off: (channel: string, callback: IpcCallback) => {
    ipcRenderer.removeListener(channel, callback);
  },
};

contextBridge.exposeInMainWorld('electronAPI', electronAPI);

export type ElectronAPI = typeof electronAPI;
