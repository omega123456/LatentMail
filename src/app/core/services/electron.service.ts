import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';

/** Per-channel shared state so we only add one IPC listener per channel (avoids MaxListenersExceededWarning). */
interface ChannelState<T> {
  subject: Subject<T>;
  callback: (_event: unknown, ...args: unknown[]) => void;
  refCount: number;
}

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

/** Payload for mail:fetch-older-done event (success: threads/hasMore/nextBeforeDate; error: error string). */
export interface MailFetchOlderDonePayload {
  queueId: string;
  accountId: number;
  folderId: string;
  threads?: Array<Record<string, unknown>>;
  hasMore?: boolean;
  nextBeforeDate?: string | null;
  error?: string;
}

interface ElectronAPI {
  mail: {
    fetchEmails: (accountId: string, folderId: string, options?: { limit?: number; offset?: number }) => Promise<IpcResponse>;
    fetchThread: (accountId: string, threadId: string, forceFromServer?: boolean) => Promise<IpcResponse>;
    getThreadFromDb: (accountId: string, threadId: string, folderId?: string) => Promise<IpcResponse>;
    send: (accountId: string, message: unknown) => Promise<IpcResponse>;
    move: (accountId: string, messageIds: string[], targetFolder: string, sourceFolder?: string) => Promise<IpcResponse>;
    flag: (accountId: string, messageIds: string[], flag: string, value: boolean) => Promise<IpcResponse>;
    delete: (accountId: string, messageIds: string[], folder: string) => Promise<IpcResponse>;
    search: (accountId: string, query: string | string[]) => Promise<IpcResponse>;
    searchImap: (accountId: string, query: string | string[]) => Promise<IpcResponse>;
    syncAccount: (accountId: string) => Promise<IpcResponse>;
    getFolders: (accountId: string) => Promise<IpcResponse>;
    fetchOlderEmails: (accountId: string, folderId: string, beforeDate: string, limit: number) => Promise<IpcResponse>;
  };
  auth: {
    login: () => Promise<IpcResponse>;
    logout: (accountId: string) => Promise<IpcResponse>;
    getAccounts: () => Promise<IpcResponse>;
    getAccountCount: () => Promise<IpcResponse>;
  };
  ai: {
    summarize: (threadContent: string, requestId?: string) => Promise<IpcResponse>;
    compose: (prompt: string, context?: string, requestId?: string) => Promise<IpcResponse>;
    categorize: (emailContent: string) => Promise<IpcResponse>;
    search: (accountId: string, naturalQuery: string, folders?: string[]) => Promise<IpcResponse>;
    transform: (text: string, transformation: string, requestId?: string) => Promise<IpcResponse>;
    getModels: () => Promise<IpcResponse>;
    getStatus: () => Promise<IpcResponse>;
    setUrl: (url: string) => Promise<IpcResponse>;
    setModel: (model: string) => Promise<IpcResponse>;
    generateReplies: (threadContent: string) => Promise<IpcResponse>;
    generateFilter: (description: string, accountId: number) => Promise<IpcResponse>;
    detectFollowUp: (emailContent: string) => Promise<IpcResponse>;
  };
  compose: {
    searchContacts: (query: string) => Promise<IpcResponse>;
    getSignatures: () => Promise<IpcResponse>;
    saveSignatures: (signatures: unknown) => Promise<IpcResponse>;
    deleteSignature: (signatureId: string) => Promise<IpcResponse>;
  };
  queue: {
    enqueue: (operation: unknown) => Promise<IpcResponse>;
    getStatus: () => Promise<IpcResponse>;
    retryFailed: (params?: { queueId?: string }) => Promise<IpcResponse>;
    clearCompleted: () => Promise<IpcResponse>;
    cancel: (params: { queueId: string }) => Promise<IpcResponse>;
    getPendingCount: () => Promise<IpcResponse>;
  };
  db: {
    getSettings: (keys?: string[]) => Promise<IpcResponse>;
    setSettings: (settings: Record<string, string>) => Promise<IpcResponse>;
    getFilters: (accountId: number) => Promise<IpcResponse>;
    saveFilter: (filter: unknown) => Promise<IpcResponse>;
    updateFilter: (filter: unknown) => Promise<IpcResponse>;
    deleteFilter: (filterId: number) => Promise<IpcResponse>;
    toggleFilter: (filterId: number, isEnabled: boolean) => Promise<IpcResponse>;
    setLogLevel: (level: string) => Promise<IpcResponse>;
  };
  filter: {
    applyAll: (accountId: number) => Promise<IpcResponse>;
  };
  system: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    getPlatform: () => Promise<string>;
  };
  on: (channel: string, callback: (...args: unknown[]) => void) => void;
  off: (channel: string, callback: (...args: unknown[]) => void) => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

@Injectable({ providedIn: 'root' })
export class ElectronService {
  private readonly api: ElectronAPI | undefined;
  private readonly isElectronEnv: boolean;
  private readonly channelState = new Map<string, ChannelState<unknown>>();

  constructor(private ngZone: NgZone) {
    this.api = window.electronAPI;
    this.isElectronEnv = !!this.api;
  }

  get isElectron(): boolean {
    return this.isElectronEnv;
  }

  // ---- Mail operations ----

  async fetchEmails(accountId: string, folderId: string, options?: { limit?: number; offset?: number }): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.fetchEmails(accountId, folderId, options));
  }

  async fetchThread(accountId: string, threadId: string, forceFromServer?: boolean): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.fetchThread(accountId, threadId, forceFromServer));
  }

  async getThreadFromDb(accountId: string, threadId: string, folderId?: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.getThreadFromDb(accountId, threadId, folderId));
  }

  async sendMail(accountId: string, message: unknown): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.send(accountId, message));
  }

  async moveEmails(accountId: string, messageIds: string[], targetFolder: string, sourceFolder?: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.move(accountId, messageIds, targetFolder, sourceFolder));
  }

  async flagEmails(accountId: string, messageIds: string[], flag: string, value: boolean): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.flag(accountId, messageIds, flag, value));
  }

  async deleteEmails(accountId: string, messageIds: string[], folder: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.delete(accountId, messageIds, folder));
  }

  async searchEmails(accountId: string, query: string | string[]): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.search(accountId, query));
  }

  async searchImapEmails(accountId: string, query: string | string[]): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.searchImap(accountId, query));
  }

  async syncAccount(accountId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.syncAccount(accountId));
  }

  async getFolders(accountId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.getFolders(accountId));
  }

  async fetchOlderEmails(accountId: string, folderId: string, beforeDate: string, limit: number): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.fetchOlderEmails(accountId, folderId, beforeDate, limit));
  }

  // ---- Auth operations ----

  async login(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.auth.login());
  }

  async logout(accountId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.auth.logout(accountId));
  }

  async getAccounts(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.auth.getAccounts());
  }

  async getAccountCount(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.auth.getAccountCount());
  }

  // ---- AI operations ----

  async aiSummarize(threadContent: string, requestId?: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.summarize(threadContent, requestId));
  }

  async aiCompose(prompt: string, context?: string, requestId?: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.compose(prompt, context, requestId));
  }

  async aiCategorize(emailContent: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.categorize(emailContent));
  }

  async aiSearch(accountId: string, naturalQuery: string, folders?: string[]): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.search(accountId, naturalQuery, folders));
  }

  async aiTransform(text: string, transformation: string, requestId?: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.transform(text, transformation, requestId));
  }

  async aiGetModels(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.getModels());
  }

  async aiGetStatus(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.getStatus());
  }

  async aiSetUrl(url: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.setUrl(url));
  }

  async aiSetModel(model: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.setModel(model));
  }

  async aiGenerateReplies(threadContent: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.generateReplies(threadContent));
  }

  async aiGenerateFilter(description: string, accountId: number): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.generateFilter(description, accountId));
  }

  async aiDetectFollowUp(emailContent: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.detectFollowUp(emailContent));
  }

  // ---- Compose operations (signatures & contacts only) ----

  async searchContacts(query: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.compose.searchContacts(query));
  }

  async getSignatures(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.compose.getSignatures());
  }

  async saveSignatures(signatures: unknown): Promise<IpcResponse> {
    return this.invoke(() => this.api!.compose.saveSignatures(signatures));
  }

  async deleteSignature(signatureId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.compose.deleteSignature(signatureId));
  }

  // ---- Queue operations ----

  async enqueueOperation(operation: {
    type: string;
    accountId: number;
    payload: unknown;
    description?: string;
    queueId?: string;
  }): Promise<IpcResponse> {
    return this.invoke(() => this.api!.queue.enqueue(operation));
  }

  async getQueueStatus(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.queue.getStatus());
  }

  async retryFailedOperations(queueId?: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.queue.retryFailed(queueId ? { queueId } : undefined));
  }

  async clearCompletedOperations(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.queue.clearCompleted());
  }

  async cancelOperation(queueId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.queue.cancel({ queueId }));
  }

  async getPendingOperationCount(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.queue.getPendingCount());
  }

  // ---- DB/Settings operations ----

  async getSettings(keys?: string[]): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.getSettings(keys));
  }

  async setSettings(settings: Record<string, string>): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.setSettings(settings));
  }

  async getFilters(accountId: number): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.getFilters(accountId));
  }

  async saveFilter(filter: unknown): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.saveFilter(filter));
  }

  async updateFilter(filter: unknown): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.updateFilter(filter));
  }

  async deleteFilter(filterId: number): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.deleteFilter(filterId));
  }

  async toggleFilter(filterId: number, isEnabled: boolean): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.toggleFilter(filterId, isEnabled));
  }

  async setLogLevel(level: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.setLogLevel(level));
  }

  // ---- Filter operations ----

  async applyFilters(accountId: number): Promise<IpcResponse> {
    return this.invoke(() => this.api!.filter.applyAll(accountId));
  }

  // ---- System operations ----

  async minimize(): Promise<void> {
    if (this.api) await this.api.system.minimize();
  }

  async maximize(): Promise<void> {
    if (this.api) await this.api.system.maximize();
  }

  async closeWindow(): Promise<void> {
    if (this.api) await this.api.system.close();
  }

  async isMaximized(): Promise<boolean> {
    if (this.api) return this.api.system.isMaximized();
    return false;
  }

  async getPlatform(): Promise<string> {
    if (this.api) return this.api.system.getPlatform();
    return 'browser';
  }

  // ---- Event streams (main → renderer push events) ----
  // One IPC listener per channel is shared by all subscribers to avoid MaxListenersExceededWarning.

  /** Payload for mail:fetch-older-done (success or error from queue worker). */
  onFetchOlderDone(): Observable<MailFetchOlderDonePayload> {
    return this.onEvent<MailFetchOlderDonePayload>('mail:fetch-older-done');
  }

  onEvent<T = unknown>(channel: string): Observable<T> {
    if (!this.api) {
      return new Observable<T>();
    }

    const state = this.getOrCreateChannelState<T>(channel);
    return new Observable<T>((subscriber) => {
      state.refCount++;
      if (state.refCount === 1) {
        this.api!.on(channel, state.callback);
      }
      const sub = state.subject.subscribe(subscriber);
      return () => {
        sub.unsubscribe();
        state.refCount--;
        if (state.refCount === 0) {
          this.api?.off(channel, state.callback);
          this.channelState.delete(channel);
        }
      };
    });
  }

  private getOrCreateChannelState<T>(channel: string): ChannelState<T> {
    let state = this.channelState.get(channel) as ChannelState<T> | undefined;
    if (!state) {
      const subject = new Subject<T>();
      const callback = (_event: unknown, ...args: unknown[]) => {
        this.ngZone.run(() => {
          subject.next(args[0] as T);
        });
      };
      state = { subject, callback, refCount: 0 };
      this.channelState.set(channel, state as ChannelState<unknown>);
    }
    return state;
  }

  // ---- Helper ----

  private async invoke(fn: () => Promise<IpcResponse>): Promise<IpcResponse> {
    if (!this.api) {
      return {
        success: false,
        error: { code: 'NOT_ELECTRON', message: 'Not running in Electron environment' },
      };
    }
    const result = await fn();
    return new Promise((resolve) => {
      this.ngZone.run(() => resolve(result));
    });
  }
}
