export interface ResetDbOptions {
  seedAccount?: boolean;
}

export interface ResetDbResult {
  success: boolean;
  accountId?: number;
  email?: string;
}

export interface InjectEmailPayload {
  mailbox: string;
  rfc822: string;
  options?: {
    flags?: string[];
    internalDate?: string;
    xGmMsgId?: string;
    xGmThrid?: string;
    xGmLabels?: string[];
  };
}

export interface TriggerSyncPayload {
  accountId: number;
}

export interface ConfigureOllamaPayload {
  models?: string[];
  responses?: Record<string, string>;
  healthy?: boolean;
  enableAiChat?: boolean;
}

export interface TestHookResponse {
  success: boolean;
}

// Reserved for Phase 6 compose send-flow tests.
export interface SmtpCapturedResponse extends TestHookResponse {
  emails: unknown[];
}

export interface FrontendTestHooks {
  resetDb(options?: ResetDbOptions): Promise<ResetDbResult>;
  reloadWindow(): { success: boolean };
  injectEmail(payload: InjectEmailPayload): Promise<TestHookResponse>;
  triggerSync(payload: TriggerSyncPayload): Promise<TestHookResponse>;
  getSmtpCaptured(): Promise<SmtpCapturedResponse>;
  configureOllama(config: ConfigureOllamaPayload): Promise<TestHookResponse>;
}

export interface TestHookGlobal {
  testHooks?: FrontendTestHooks;
}

declare global {
  var testHooks: FrontendTestHooks | undefined;
}
