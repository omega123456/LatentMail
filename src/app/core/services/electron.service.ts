import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

interface ElectronAPI {
  mail: {
    fetchEmails: (accountId: string, folderId: string, options?: { limit?: number; offset?: number }) => Promise<IpcResponse>;
    fetchThread: (accountId: string, threadId: string) => Promise<IpcResponse>;
    send: (accountId: string, message: unknown) => Promise<IpcResponse>;
    move: (accountId: string, messageIds: string[], targetFolder: string) => Promise<IpcResponse>;
    flag: (accountId: string, messageIds: string[], flag: string, value: boolean) => Promise<IpcResponse>;
    search: (accountId: string, query: string) => Promise<IpcResponse>;
    syncAccount: (accountId: string) => Promise<IpcResponse>;
    getFolders: (accountId: string) => Promise<IpcResponse>;
  };
  auth: {
    login: () => Promise<IpcResponse>;
    logout: (accountId: string) => Promise<IpcResponse>;
    getAccounts: () => Promise<IpcResponse>;
    getAccountCount: () => Promise<IpcResponse>;
  };
  ai: {
    summarize: (threadContent: string) => Promise<IpcResponse>;
    compose: (prompt: string, context?: string) => Promise<IpcResponse>;
    categorize: (emailContent: string) => Promise<IpcResponse>;
    search: (naturalQuery: string) => Promise<IpcResponse>;
    transform: (text: string, transformation: string) => Promise<IpcResponse>;
    getModels: () => Promise<IpcResponse>;
    getStatus: () => Promise<IpcResponse>;
  };
  db: {
    getSettings: (keys?: string[]) => Promise<IpcResponse>;
    setSettings: (settings: Record<string, string>) => Promise<IpcResponse>;
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

  async fetchThread(accountId: string, threadId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.fetchThread(accountId, threadId));
  }

  async sendMail(accountId: string, message: unknown): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.send(accountId, message));
  }

  async moveEmails(accountId: string, messageIds: string[], targetFolder: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.move(accountId, messageIds, targetFolder));
  }

  async flagEmails(accountId: string, messageIds: string[], flag: string, value: boolean): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.flag(accountId, messageIds, flag, value));
  }

  async searchEmails(accountId: string, query: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.search(accountId, query));
  }

  async syncAccount(accountId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.syncAccount(accountId));
  }

  async getFolders(accountId: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.mail.getFolders(accountId));
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

  async aiSummarize(threadContent: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.summarize(threadContent));
  }

  async aiCompose(prompt: string, context?: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.compose(prompt, context));
  }

  async aiCategorize(emailContent: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.categorize(emailContent));
  }

  async aiSearch(naturalQuery: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.search(naturalQuery));
  }

  async aiTransform(text: string, transformation: string): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.transform(text, transformation));
  }

  async aiGetModels(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.getModels());
  }

  async aiGetStatus(): Promise<IpcResponse> {
    return this.invoke(() => this.api!.ai.getStatus());
  }

  // ---- DB/Settings operations ----

  async getSettings(keys?: string[]): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.getSettings(keys));
  }

  async setSettings(settings: Record<string, string>): Promise<IpcResponse> {
    return this.invoke(() => this.api!.db.setSettings(settings));
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

  onEvent<T = unknown>(channel: string): Observable<T> {
    const subject = new Subject<T>();

    if (this.api) {
      const callback = (_event: unknown, ...args: unknown[]) => {
        this.ngZone.run(() => {
          subject.next(args[0] as T);
        });
      };

      this.api.on(channel, callback);

      // Return an observable that cleans up on unsubscribe
      return new Observable<T>((subscriber) => {
        const sub = subject.subscribe(subscriber);
        return () => {
          sub.unsubscribe();
          this.api?.off(channel, callback);
        };
      });
    }

    return subject.asObservable();
  }

  // ---- Helper ----

  private async invoke(fn: () => Promise<IpcResponse>): Promise<IpcResponse> {
    if (!this.api) {
      return {
        success: false,
        error: { code: 'NOT_ELECTRON', message: 'Not running in Electron environment' },
      };
    }
    return fn();
  }
}
