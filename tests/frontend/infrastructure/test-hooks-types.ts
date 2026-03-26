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
  selectedModel?: string;
  responses?: Record<string, string>;
  healthy?: boolean;
  enableAiChat?: boolean;
}

export interface MockIpcPayload {
  channel: string;
  response?: unknown;
  throwMessage?: string;
  once?: boolean;
}

export interface EmitRendererEventPayload {
  channel: string;
  payload: unknown;
}

export interface SimulateNotificationClickPayload {
  accountId: number;
  folder: string;
  xGmThrid?: string;
}

export interface SeedQueuePayload {
  items?: Array<Record<string, unknown>>;
  bodyFetchItems?: Array<Record<string, unknown>>;
}

export interface SetAccountReauthPayload {
  accountId: number;
  needsReauth: boolean;
}

export interface TrayReauthResponse extends TestHookResponse {
  needsReauth: boolean;
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
  mockIpc(payload: MockIpcPayload): Promise<TestHookResponse>;
  clearMockIpc(channel?: string): Promise<TestHookResponse>;
  emitRendererEvent(payload: EmitRendererEventPayload): Promise<TestHookResponse>;
  simulateNotificationClick(payload: SimulateNotificationClickPayload): Promise<TestHookResponse>;
  simulateNotificationClickDuringHiddenReload(payload: SimulateNotificationClickPayload): Promise<TestHookResponse>;
  seedQueue(payload: SeedQueuePayload): Promise<TestHookResponse>;
  setAccountReauth(payload: SetAccountReauthPayload): Promise<TestHookResponse>;
  getTrayReauthState(): Promise<TrayReauthResponse>;
}

export interface TestHookGlobal {
  testHooks?: FrontendTestHooks;
}

declare global {
  var testHooks: FrontendTestHooks | undefined;
}
