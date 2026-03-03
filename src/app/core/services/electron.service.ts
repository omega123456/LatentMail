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

/** Response data from attachment:get-content IPC (filename, mimeType, size, base64 content). */
export interface AttachmentContentData {
  filename: string;
  mimeType?: string;
  size?: number;
  content: string;
}

// --- OS file drag-and-drop payload interfaces (Win32 native addon) ---
// Canonical channel definitions: electron/ipc/ipc-channels.ts

/** Payload for os-file:drag-enter event. */
export interface OsDragEnterPayload {
  fileCount: number;
  hasImages: boolean;
  /** True if ALL files are images (no non-image files in the drop). */
  onlyImages: boolean;
}

/** An image file from an OS drop, ready for inline insertion. */
export interface OsDropImage {
  filename: string;
  mimeType: string;
  /** Complete data:image/...;base64,... string ready for TipTap setImage(). */
  dataUrl: string;
}

/** A non-image file from an OS drop, compatible with DraftAttachment shape. */
export interface OsDropAttachment {
  id: string;
  filename: string;
  mimeType: string;
  size: number;
  /** Base64-encoded file content. */
  data: string;
}

/** Payload for os-file:drop event. */
export interface OsFileDropPayload {
  images: OsDropImage[];
  attachments: OsDropAttachment[];
}

/** Response data from attachment:get-content-as-text IPC (decoded text via iconv-lite in main). */
export interface AttachmentTextContentData {
  filename: string;
  mimeType?: string;
  text: string;
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

/** Payload for embedding:progress push event (sent during index build). */
export interface EmbeddingProgressPayload {
  indexed: number;
  total: number;
  percent: number;
}

/** Payload for embedding:error push event (sent when indexing fails). */
export interface EmbeddingErrorPayload {
  message: string;
}

/** Response data from ai:get-embedding-status IPC. */
export interface EmbeddingStatusData {
  embeddingModel: string | null;
  indexStatus: 'not_started' | 'building' | 'complete' | 'partial' | 'unavailable' | string;
  indexed: number;
  total: number;
  vectorDimension: number | null;
}

/** Payload for system:tray-action event (compose, sync, etc.). */
export interface TrayActionPayload {
  action: string;
}

/** Payload for ai:search:batch push event — a batch of matching message IDs from one search phase. */
export interface SearchBatchPayload {
  searchToken: string;
  msgIds: string[];
  phase: 'local' | 'imap';
}

/** Payload for ai:search:complete push event — final status after all search phases finish. */
export interface SearchCompletePayload {
  searchToken: string;
  status: 'complete' | 'partial' | 'error';
  totalResults: number;
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
    searchByMsgIds: (accountId: string, xGmMsgIds: string[]) => Promise<IpcResponse>;
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
    search: (accountId: string, naturalQuery: string, folders?: string[], mode?: string) => Promise<IpcResponse>;
    transform: (text: string, transformation: string, requestId?: string) => Promise<IpcResponse>;
    getModels: () => Promise<IpcResponse>;
    getStatus: () => Promise<IpcResponse>;
    setUrl: (url: string) => Promise<IpcResponse>;
    setModel: (model: string) => Promise<IpcResponse>;
    generateReplies: (threadContent: string) => Promise<IpcResponse>;
    generateFilter: (description: string, accountId: number) => Promise<IpcResponse>;
    detectFollowUp: (emailContent: string) => Promise<IpcResponse>;
    setEmbeddingModel: (model: string) => Promise<IpcResponse>;
    getEmbeddingStatus: () => Promise<IpcResponse>;
    buildIndex: () => Promise<IpcResponse>;
    cancelIndex: () => Promise<IpcResponse>;
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
  attachments: {
    getForEmail: (accountId: string, xGmMsgId: string) => Promise<IpcResponse>;
    getContent: (attachmentId: number) => Promise<IpcResponse<AttachmentContentData>>;
    getContentAsText: (attachmentId: number) => Promise<IpcResponse<AttachmentTextContentData>>;
    download: (attachmentId: number) => Promise<IpcResponse>;
    fetchDraftAttachments: (accountId: string, xGmMsgId: string) => Promise<IpcResponse>;
  };
  labels: {
    create: (accountId: string, name: string, color: string | null) => Promise<IpcResponse>;
    delete: (accountId: string, gmailLabelId: string) => Promise<IpcResponse>;
    updateColor: (accountId: string, gmailLabelId: string, color: string | null) => Promise<IpcResponse>;
  };
  bimi: {
    getLogo: (email: string) => Promise<IpcResponse<{ logoUrl: string | null }>>;
  };
  logger: {
    getRecentEntries: () => Promise<IpcResponse>;
  };
  system: {
    minimize: () => Promise<void>;
    maximize: () => Promise<void>;
    close: () => Promise<void>;
    isMaximized: () => Promise<boolean>;
    getPlatform: () => Promise<string>;
    getIsMacOS: () => Promise<boolean>;
    setZoom: (factor: number) => Promise<number>;
    getZoom: () => Promise<number>;
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

  async searchEmailsByMsgIds(accountId: string, xGmMsgIds: string[]): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.searchByMsgIds(accountId, xGmMsgIds));
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

  async aiSearch(accountId: string, naturalQuery: string, folders?: string[], mode?: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.search(accountId, naturalQuery, folders, mode));
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

  async aiSetEmbeddingModel(model: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.setEmbeddingModel(model));
  }

  async aiGetEmbeddingStatus(): Promise<IpcResponse<EmbeddingStatusData>> {
    return this.invoke(() => this.api!.ai.getEmbeddingStatus()) as Promise<IpcResponse<EmbeddingStatusData>>;
  }

  async aiBuildIndex(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.buildIndex());
  }

  async aiCancelIndex(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.cancelIndex());
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

  // ---- Attachment operations ----

  async getAttachmentsForEmail(accountId: string, xGmMsgId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.attachments.getForEmail(accountId, xGmMsgId));
  }

  async getAttachmentContent(attachmentId: number): Promise<IpcResponse<AttachmentContentData>> {
    return this.invoke(() => this.api!.attachments.getContent(attachmentId)) as Promise<
      IpcResponse<AttachmentContentData>
    >;
  }

  async getAttachmentContentAsText(attachmentId: number): Promise<IpcResponse<AttachmentTextContentData>> {
    return this.invoke(() => this.api!.attachments.getContentAsText(attachmentId)) as Promise<
      IpcResponse<AttachmentTextContentData>
    >;
  }

  async downloadAttachment(attachmentId: number): Promise<IpcResponse> {
    return this.invoke(() => this.api!.attachments.download(attachmentId));
  }

  async fetchDraftAttachments(accountId: string, xGmMsgId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.attachments.fetchDraftAttachments(accountId, xGmMsgId));
  }

  // ---- Label CRUD operations ----

  async createLabel(accountId: string, name: string, color: string | null): Promise<IpcResponse> {
    return this.invoke(() => this.api!.labels.create(accountId, name, color));
  }

  async deleteLabel(accountId: string, gmailLabelId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.labels.delete(accountId, gmailLabelId));
  }

  async updateLabelColor(accountId: string, gmailLabelId: string, color: string | null): Promise<IpcResponse> {
    return this.invoke(() => this.api!.labels.updateColor(accountId, gmailLabelId, color));
  }

  /** Get BIMI logo URL for sender domain (cached in main process). */
  async getBimiLogo(email: string): Promise<IpcResponse<{ logoUrl: string | null }>> {
    return this.invoke(() => this.api!.bimi.getLogo(email)) as Promise<
      IpcResponse<{ logoUrl: string | null }>
    >;
  }

  // ---- Logger operations ----

  async getRecentLogEntries(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.logger.getRecentEntries());
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

  async getIsMacOS(): Promise<boolean> {
    if (this.api) return this.api.system.getIsMacOS();
    return false;
  }

  async setZoom(factor: number): Promise<number> {
    if (this.api) return this.api.system.setZoom(factor);
    return factor;
  }

  async getZoom(): Promise<number> {
    if (this.api) return this.api.system.getZoom();
    return 1.0;
  }

  // ---- Event streams (main → renderer push events) ----
  // One IPC listener per channel is shared by all subscribers to avoid MaxListenersExceededWarning.

  /** Payload for mail:fetch-older-done (success or error from queue worker). */
  onFetchOlderDone(): Observable<MailFetchOlderDonePayload> {
    return this.onEvent<MailFetchOlderDonePayload>('mail:fetch-older-done');
  }

  // --- OS file drag-and-drop events (Win32 native addon → renderer) ---
  // Channel strings match canonical definitions in electron/ipc/ipc-channels.ts

  /** Fires when files are dragged from OS (Explorer) over the window. */
  onOsFileDragEnter(): Observable<OsDragEnterPayload> {
    return this.onEvent<OsDragEnterPayload>('os-file:drag-enter');
  }

  /** Fires when the OS file drag leaves the window. */
  onOsFileDragLeave(): Observable<void> {
    return this.onEvent<void>('os-file:drag-leave');
  }

  /** Fires when files from OS (Explorer) are dropped on the window. */
  onOsFileDrop(): Observable<OsFileDropPayload> {
    return this.onEvent<OsFileDropPayload>('os-file:drop');
  }

  /** Fires when the user chooses an action from the system tray context menu (e.g. compose, sync). */
  onTrayAction(): Observable<TrayActionPayload> {
    return this.onEvent<TrayActionPayload>('system:tray-action');
  }

  /** Fires when a batch of matching message IDs arrives during an AI semantic search (local or IMAP phase). */
  onAiSearchBatch(): Observable<SearchBatchPayload> {
    return this.onEvent<SearchBatchPayload>('ai:search:batch');
  }

  /** Fires when all phases of an AI semantic search have finished (complete, partial, or error). */
  onAiSearchComplete(): Observable<SearchCompletePayload> {
    return this.onEvent<SearchCompletePayload>('ai:search:complete');
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
