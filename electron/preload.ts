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
    fetchThread: (accountId: string, threadId: string) =>
      ipcRenderer.invoke('mail:fetch-thread', accountId, threadId) as Promise<IpcResponse>,
    send: (accountId: string, message: unknown) =>
      ipcRenderer.invoke('mail:send', accountId, message) as Promise<IpcResponse>,
    move: (accountId: string, messageIds: string[], targetFolder: string, sourceFolder?: string) =>
      ipcRenderer.invoke('mail:move', accountId, messageIds, targetFolder, sourceFolder) as Promise<IpcResponse>,
    flag: (accountId: string, messageIds: string[], flag: string, value: boolean) =>
      ipcRenderer.invoke('mail:flag', accountId, messageIds, flag, value) as Promise<IpcResponse>,
    search: (accountId: string, query: string) =>
      ipcRenderer.invoke('mail:search', accountId, query) as Promise<IpcResponse>,
    syncAccount: (accountId: string) =>
      ipcRenderer.invoke('mail:sync-account', accountId) as Promise<IpcResponse>,
    getFolders: (accountId: string) =>
      ipcRenderer.invoke('mail:get-folders', accountId) as Promise<IpcResponse>,
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
    summarize: (threadContent: string) =>
      ipcRenderer.invoke('ai:summarize', threadContent) as Promise<IpcResponse>,
    compose: (prompt: string, context?: string) =>
      ipcRenderer.invoke('ai:compose', prompt, context) as Promise<IpcResponse>,
    categorize: (emailContent: string) =>
      ipcRenderer.invoke('ai:categorize', emailContent) as Promise<IpcResponse>,
    search: (naturalQuery: string) =>
      ipcRenderer.invoke('ai:search', naturalQuery) as Promise<IpcResponse>,
    transform: (text: string, transformation: string) =>
      ipcRenderer.invoke('ai:transform', text, transformation) as Promise<IpcResponse>,
    getModels: () =>
      ipcRenderer.invoke('ai:get-models') as Promise<IpcResponse>,
    getStatus: () =>
      ipcRenderer.invoke('ai:get-status') as Promise<IpcResponse>,
  },

  // Compose operations
  compose: {
    saveDraft: (draft: unknown) =>
      ipcRenderer.invoke('compose:save-draft', draft) as Promise<IpcResponse>,
    getDrafts: (accountId: number) =>
      ipcRenderer.invoke('compose:get-drafts', accountId) as Promise<IpcResponse>,
    getDraft: (draftId: number) =>
      ipcRenderer.invoke('compose:get-draft', draftId) as Promise<IpcResponse>,
    deleteDraft: (draftId: number) =>
      ipcRenderer.invoke('compose:delete-draft', draftId) as Promise<IpcResponse>,
    deleteDraftOnServer: (accountId: number, gmailMessageId: string) =>
      ipcRenderer.invoke('compose:delete-draft-on-server', accountId, gmailMessageId) as Promise<IpcResponse>,
    searchContacts: (query: string) =>
      ipcRenderer.invoke('compose:search-contacts', query) as Promise<IpcResponse>,
    getSignatures: () =>
      ipcRenderer.invoke('compose:get-signatures') as Promise<IpcResponse>,
    saveSignatures: (signatures: unknown) =>
      ipcRenderer.invoke('compose:save-signature', signatures) as Promise<IpcResponse>,
    deleteSignature: (signatureId: string) =>
      ipcRenderer.invoke('compose:delete-signature', signatureId) as Promise<IpcResponse>,
  },

  // Database/settings operations
  db: {
    getSettings: (keys?: string[]) =>
      ipcRenderer.invoke('db:get-settings', keys) as Promise<IpcResponse>,
    setSettings: (settings: Record<string, string>) =>
      ipcRenderer.invoke('db:set-settings', settings) as Promise<IpcResponse>,
  },

  // System operations
  system: {
    minimize: () => ipcRenderer.invoke('system:minimize') as Promise<void>,
    maximize: () => ipcRenderer.invoke('system:maximize') as Promise<void>,
    close: () => ipcRenderer.invoke('system:close') as Promise<void>,
    isMaximized: () => ipcRenderer.invoke('system:is-maximized') as Promise<boolean>,
    getPlatform: () => ipcRenderer.invoke('system:get-platform') as Promise<string>,
  },

  // Event listeners (for push events from main process)
  on: (channel: string, callback: IpcCallback) => {
    const validChannels = [
      'mail:sync',
      'auth:refresh',
      'ai:status',
      'ai:stream',
      'system:notification',
      'system:tray-action',
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
