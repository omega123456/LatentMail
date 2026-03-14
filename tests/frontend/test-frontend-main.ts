import { app, BrowserWindow, protocol, type IpcMainInvokeEvent } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DateTime } from 'luxon';

import { isWindows } from '../../electron/utils/platform';
import { quiesceAndRestore } from '../backend/infrastructure/suite-lifecycle';
import { TestEventBus } from '../backend/infrastructure/test-event-bus';
import type {
  ConfigureOllamaPayload,
  InjectEmailPayload,
  ResetDbOptions,
  ResetDbResult,
  SmtpCapturedResponse,
  TestHookResponse,
  TriggerSyncPayload,
} from './infrastructure/test-hooks-types';
import { initializeBootstrap, type BootstrapResult } from '../shared/test-bootstrap';

interface FrontendIpcResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

protocol.registerSchemesAsPrivileged([
  { scheme: 'bimi-logo', privileges: { bypassCSP: true, standard: true } },
  { scheme: 'account-avatar', privileges: { bypassCSP: true, standard: true } },
]);

app.setAppUserModelId('com.latentmail.app');
app.disableHardwareAcceleration();

let mainWindow: BrowserWindow | null = null;
let bootstrap: BootstrapResult | null = null;
let tempDirPath: string | null = null;
let shutdownPromise: Promise<void> | null = null;

function getAngularEntryPath(): string {
  return path.resolve(__dirname, '../../../dist/latentmail-app/browser/index.html');
}

function ensureBootstrap(): BootstrapResult {
  if (bootstrap === null) {
    throw new Error('Frontend test bootstrap has not been initialized.');
  }

  return bootstrap;
}

function ensureMainWindow(): BrowserWindow {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    throw new Error('Frontend test window is not available.');
  }

  return mainWindow;
}

function shouldExposeTestHooks(): boolean {
  return process.env['LATENTMAIL_TEST_MODE'] === '1' && !app.isPackaged;
}

function seedDefaultTestAccount(bootstrapResult: BootstrapResult): {
  accountId: number;
  email: string;
} {
  const { seedTestAccount } = require('../shared/account-seeding') as typeof import('../shared/account-seeding');
  const seededAccount = seedTestAccount({}, {
    imapStateInspector: bootstrapResult.imapStateInspector,
    smtpServer: bootstrapResult.smtpServer,
    oauthServer: bootstrapResult.oauthServer,
  });

  return {
    accountId: seededAccount.accountId,
    email: seededAccount.email,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function validateResetDbOptions(options: unknown): ResetDbOptions {
  if (options === undefined) {
    return {};
  }

  if (!isRecord(options)) {
    throw new Error('resetDb options must be an object when provided.');
  }

  if (options['seedAccount'] !== undefined && typeof options['seedAccount'] !== 'boolean') {
    throw new Error('resetDb options.seedAccount must be a boolean when provided.');
  }

  return {
    seedAccount: options['seedAccount'] as boolean | undefined,
  };
}

function validateInjectEmailPayload(payload: unknown): InjectEmailPayload {
  if (!isRecord(payload)) {
    throw new Error('injectEmail payload must be an object.');
  }

  if (typeof payload['mailbox'] !== 'string' || payload['mailbox'].trim().length === 0) {
    throw new Error('injectEmail payload.mailbox must be a non-empty string.');
  }

  if (typeof payload['rfc822'] !== 'string' || payload['rfc822'].length === 0) {
    throw new Error('injectEmail payload.rfc822 must be a non-empty base64 string.');
  }

  const options = payload['options'];
  if (options !== undefined && !isRecord(options)) {
    throw new Error('injectEmail payload.options must be an object when provided.');
  }

  return {
    mailbox: payload['mailbox'].trim(),
    rfc822: payload['rfc822'],
    options: options as InjectEmailPayload['options'],
  };
}

function validateTriggerSyncPayload(payload: unknown): TriggerSyncPayload {
  if (!isRecord(payload)) {
    throw new Error('triggerSync payload must be an object.');
  }

  if (typeof payload['accountId'] !== 'number' || !Number.isFinite(payload['accountId']) || payload['accountId'] <= 0) {
    throw new Error('triggerSync payload.accountId must be a positive number.');
  }

  return {
    accountId: payload['accountId'],
  };
}

function validateConfigureOllamaPayload(payload: unknown): ConfigureOllamaPayload {
  if (!isRecord(payload)) {
    throw new Error('configureOllama payload must be an object.');
  }

  const models = payload['models'];
  if (models !== undefined) {
    if (!Array.isArray(models) || !models.every((model) => typeof model === 'string')) {
      throw new Error('configureOllama payload.models must be a string array when provided.');
    }
  }

  const responses = payload['responses'];
  if (responses !== undefined) {
    if (!isRecord(responses)) {
      throw new Error('configureOllama payload.responses must be an object when provided.');
    }

    for (const value of Object.values(responses)) {
      if (typeof value !== 'string') {
        throw new Error('configureOllama payload.responses values must all be strings.');
      }
    }
  }

  if (payload['healthy'] !== undefined && typeof payload['healthy'] !== 'boolean') {
    throw new Error('configureOllama payload.healthy must be a boolean when provided.');
  }

  if (payload['enableAiChat'] !== undefined && typeof payload['enableAiChat'] !== 'boolean') {
    throw new Error('configureOllama payload.enableAiChat must be a boolean when provided.');
  }

  return {
    models: models as string[] | undefined,
    responses: responses as Record<string, string> | undefined,
    healthy: payload['healthy'] as boolean | undefined,
    enableAiChat: payload['enableAiChat'] as boolean | undefined,
  };
}

function getSyncEventCounts(accountId: number): {
  priorFolderUpdatedCount: number;
  priorQueueUpdateCount: number;
} {
  const bus = TestEventBus.getInstance();

  const priorFolderUpdatedCount = bus.getHistory('mail:folder-updated').filter((record) => {
    const payload = record.args[0] as Record<string, unknown> | undefined;
    return payload !== undefined && Number(payload['accountId']) === accountId && payload['reason'] === 'sync';
  }).length;

  const priorQueueUpdateCount = bus.getHistory('queue:update').filter((record) => {
    const snapshot = record.args[0] as Record<string, unknown> | undefined;
    return (
      snapshot !== undefined &&
      Number(snapshot['accountId']) === accountId &&
      (snapshot['type'] === 'sync-allmail' || snapshot['type'] === 'sync-folder') &&
      (snapshot['status'] === 'completed' || snapshot['status'] === 'failed')
    );
  }).length;

  return { priorFolderUpdatedCount, priorQueueUpdateCount };
}

async function waitForTriggeredSync(
  accountId: number,
  queueId: string | null,
  priorFolderUpdatedCount: number,
  priorQueueUpdateCount: number,
  timeoutMs: number = 15_000,
): Promise<void> {
  const bus = TestEventBus.getInstance();

  await new Promise<void>((resolve, reject) => {
    let settled = false;

    const timeoutHandle = setTimeout(() => {
      if (settled) {
        return;
      }

      settled = true;
      reject(new Error(`triggerSync timed out after ${timeoutMs}ms waiting for sync to complete.`));
    }, timeoutMs);

    function settle(): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      resolve();
    }

    function rejectWithError(message: string): void {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutHandle);
      reject(new Error(message));
    }

    const folderUpdatedPredicate = (args: unknown[]): boolean => {
      const payload = args[0] as Record<string, unknown> | undefined;
      if (payload === undefined) {
        return false;
      }

      if (Number(payload['accountId']) !== accountId) {
        return false;
      }

      if (payload['reason'] !== 'sync') {
        return false;
      }

      const currentCount = bus.getHistory('mail:folder-updated').filter((record) => {
        const recordPayload = record.args[0] as Record<string, unknown> | undefined;
        return (
          recordPayload !== undefined &&
          Number(recordPayload['accountId']) === accountId &&
          recordPayload['reason'] === 'sync'
        );
      }).length;

      return currentCount > priorFolderUpdatedCount;
    };

    const queueUpdatePredicate = (args: unknown[]): boolean => {
      const snapshot = args[0] as Record<string, unknown> | undefined;
      if (snapshot === undefined) {
        return false;
      }

      if (Number(snapshot['accountId']) !== accountId) {
        return false;
      }

      if (snapshot['type'] !== 'sync-allmail' && snapshot['type'] !== 'sync-folder') {
        return false;
      }

      if (snapshot['status'] !== 'completed' && snapshot['status'] !== 'failed') {
        return false;
      }

      if (queueId !== null) {
        return snapshot['queueId'] === queueId;
      }

      const relevantEvents = bus.getHistory('queue:update').filter((record) => {
        const recordSnapshot = record.args[0] as Record<string, unknown> | undefined;
        return (
          recordSnapshot !== undefined &&
          Number(recordSnapshot['accountId']) === accountId &&
          (recordSnapshot['type'] === 'sync-allmail' || recordSnapshot['type'] === 'sync-folder') &&
          (recordSnapshot['status'] === 'completed' || recordSnapshot['status'] === 'failed')
        );
      });

      return relevantEvents.length > priorQueueUpdateCount;
    };

    void bus.waitFor('mail:folder-updated', {
      timeout: timeoutMs,
      predicate: folderUpdatedPredicate,
    }).then(() => {
      settle();
    }).catch(() => {
      // queue:update may still resolve the sync.
    });

    void bus.waitFor('queue:update', {
      timeout: timeoutMs,
      predicate: queueUpdatePredicate,
    }).then((args) => {
      const snapshot = args[0] as Record<string, unknown> | undefined;
      if (snapshot !== undefined && snapshot['status'] === 'failed') {
        const errorMessage = typeof snapshot['error'] === 'string'
          ? snapshot['error']
          : 'sync worker reported failed status';
        rejectWithError(`triggerSync failed: ${errorMessage}`);
        return;
      }

      settle();
    }).catch(() => {
      // The outer timeout handles total failure.
    });
  });
}

function configureFakeOllamaResponses(config: ConfigureOllamaPayload): void {
  const bootstrapResult = ensureBootstrap();
  const responses = config.responses;
  if (responses === undefined) {
    return;
  }

  const chatResponse = responses['chat'] ?? responses['chatResponse'] ?? responses['default'];
  if (chatResponse !== undefined) {
    bootstrapResult.ollamaServer.setChatResponse(chatResponse);
    bootstrapResult.ollamaServer.setChatStreamChunks([chatResponse]);
  }

  const generateResponse = responses['generate'] ?? responses['generateResponse'] ?? responses['default'];
  if (generateResponse !== undefined) {
    bootstrapResult.ollamaServer.setGenerateResponse(generateResponse);
    bootstrapResult.ollamaServer.setGenerateStreamChunks([generateResponse]);
  }
}

function createDeterministicEmbeddingVector(dimension: number): number[] {
  return Array.from({ length: dimension }, (_, index) => {
    return index === 0 ? 1 : 0;
  });
}

function enableAiChatIndexFixture(): void {
  const { DatabaseService } = require('../../electron/services/database-service') as typeof import('../../electron/services/database-service');
  const { VectorDbService } = require('../../electron/services/vector-db-service') as typeof import('../../electron/services/vector-db-service');
  const { OllamaService } = require('../../electron/services/ollama-service') as typeof import('../../electron/services/ollama-service');

  const databaseService = DatabaseService.getInstance();
  const vectorDbService = VectorDbService.getInstance();
  const ollamaService = OllamaService.getInstance();

  const activeAccount = databaseService.getAccounts().find((account) => account.isActive);
  if (activeAccount === undefined) {
    throw new Error('enableAiChatIndexFixture requires an active seeded account.');
  }

  const embeddingModel = 'nomic-embed-text:latest';
  const vectorDimension = 768;
  const embeddingVector = createDeterministicEmbeddingVector(vectorDimension);

  vectorDbService.configureModel(embeddingModel, vectorDimension);
  ollamaService.setEmbeddingModel(embeddingModel);

  const emailRows = databaseService.getDatabase().prepare(
    `SELECT x_gm_msgid, account_id, subject, text_body, html_body, snippet
     FROM emails
     WHERE account_id = :accountId
     ORDER BY date DESC
     LIMIT 25`
  ).all({ accountId: activeAccount.id }) as Array<{
    x_gm_msgid: string;
    account_id: number;
    subject: string | null;
    text_body: string | null;
    html_body: string | null;
    snippet: string | null;
  }>;

  if (emailRows.length === 0) {
    return;
  }

  const indexedRecords: Array<{ xGmMsgId: string; embeddingHash: string }> = [];

  for (const email of emailRows) {
    const chunkText = [
      email.subject,
      email.text_body,
      email.html_body,
      email.snippet,
    ].filter((value): value is string => {
      return typeof value === 'string' && value.trim().length > 0;
    }).join('\n\n');

    if (chunkText.trim().length === 0) {
      continue;
    }

    vectorDbService.insertChunks({
      accountId: email.account_id,
      xGmMsgId: email.x_gm_msgid,
      chunks: [{
        chunkIndex: 0,
        chunkText,
        embedding: embeddingVector,
      }],
    });

    indexedRecords.push({
      xGmMsgId: email.x_gm_msgid,
      embeddingHash: `frontend-ai-chat-${email.x_gm_msgid}`,
    });
  }

  if (indexedRecords.length === 0) {
    return;
  }

  databaseService.batchInsertVectorIndexedEmails(activeAccount.id, indexedRecords);
  databaseService.setEmbeddingBuildInterrupted(activeAccount.id, false);
}

async function triggerOllamaHealthCheck(): Promise<void> {
  const { OllamaService } = require('../../electron/services/ollama-service') as typeof import('../../electron/services/ollama-service');
  await OllamaService.getInstance().checkHealth();
}

function installWebContentsSendTap(window: BrowserWindow): void {
  const originalSend = window.webContents.send.bind(window.webContents);

  window.webContents.send = ((channel: string, ...args: unknown[]) => {
    originalSend(channel, ...args);
    TestEventBus.getInstance().emit(channel, args);
  }) as typeof window.webContents.send;
}

async function createMainWindow(): Promise<BrowserWindow> {
  const preloadPath = path.resolve(__dirname, '../../electron/preload.js');
  const angularEntryPath = getAngularEntryPath();

  if (!fs.existsSync(preloadPath)) {
    throw new Error(`Production preload script not found at ${preloadPath}`);
  }

  if (!fs.existsSync(angularEntryPath)) {
    throw new Error(`Angular dist entrypoint not found at ${angularEntryPath}`);
  }

  const isWindowsPlatform = isWindows();
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: !isWindowsPlatform,
    titleBarStyle: isWindowsPlatform ? undefined : 'hiddenInset',
    show: false,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webviewTag: false,
    },
  });

  installWebContentsSendTap(window);

  const didFinishLoadPromise = new Promise<void>((resolve, reject) => {
    window.webContents.once('did-finish-load', () => {
      resolve();
    });

    window.webContents.once('did-fail-load', (_event, errorCode, errorDescription, validatedUrl, isMainFrame) => {
      if (!isMainFrame) {
        return;
      }

      reject(new Error(`Failed to load Angular app (${errorCode}) ${errorDescription} at ${validatedUrl}`));
    });
  });

  await window.loadFile(angularEntryPath);
  await didFinishLoadPromise;
  await window.webContents.insertCSS('*, *::before, *::after { transition: none !important; animation: none !important; }');
  window.show();

  return window;
}

async function quiesceServicesForShutdown(): Promise<void> {
  try {
    const { SyncQueueBridge } = require('../../electron/services/sync-queue-bridge') as typeof import('../../electron/services/sync-queue-bridge');
    SyncQueueBridge.getInstance().resetForTesting();
  } catch {
    // Best effort during shutdown.
  }

  try {
    const { BodyFetchQueueService } = require('../../electron/services/body-fetch-queue-service') as typeof import('../../electron/services/body-fetch-queue-service');
    BodyFetchQueueService.getInstance().resetForTesting();
  } catch {
    // Best effort during shutdown.
  }

  try {
    const { ImapService } = require('../../electron/services/imap-service') as typeof import('../../electron/services/imap-service');
    await ImapService.getInstance().disconnectAllAndClearPending();
  } catch {
    // Best effort during shutdown.
  }

  try {
    const { ImapCrawlService } = require('../../electron/services/imap-crawl-service') as typeof import('../../electron/services/imap-crawl-service');
    await ImapCrawlService.getInstance().disconnectAll();
  } catch {
    // Best effort during shutdown.
  }

  try {
    const { MailQueueService } = require('../../electron/services/mail-queue-service') as typeof import('../../electron/services/mail-queue-service');
    MailQueueService.getInstance().cancelAllRetries();
  } catch {
    // Best effort during shutdown.
  }
}

async function stopMockServersForShutdown(): Promise<void> {
  if (bootstrap === null) {
    return;
  }

  await Promise.allSettled([
    bootstrap.imapServer.stop(),
    bootstrap.smtpServer.stop(),
    bootstrap.oauthServer.stop(),
    bootstrap.ollamaServer.stop(),
  ]);
}

function cleanupTempDir(): void {
  if (tempDirPath === null) {
    return;
  }

  try {
    fs.rmSync(tempDirPath, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Best effort during shutdown.
  }
}

async function shutdownFrontendHarness(): Promise<void> {
  if (shutdownPromise !== null) {
    await shutdownPromise;
    return;
  }

  shutdownPromise = (async () => {
    globalThis.testHooks = undefined;

    try {
      if (mainWindow !== null && !mainWindow.isDestroyed()) {
        mainWindow.destroy();
      }
    } catch {
      // Best effort during shutdown.
    }

    mainWindow = null;

    try {
      await quiesceServicesForShutdown();
    } catch {
      // Best effort during shutdown.
    }

    try {
      await stopMockServersForShutdown();
    } catch {
      // Best effort during shutdown.
    }

    cleanupTempDir();
  })();

  await shutdownPromise;
}

function registerShutdownHandlers(): void {
  process.once('SIGINT', () => {
    void shutdownFrontendHarness().finally(() => {
      app.quit();
    });
  });

  process.once('SIGTERM', () => {
    void shutdownFrontendHarness().finally(() => {
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    void shutdownFrontendHarness().finally(() => {
      app.quit();
    });
  });

  app.once('will-quit', () => {
    globalThis.testHooks = undefined;
  });
}

function registerTestHooks(): void {
  if (!shouldExposeTestHooks()) {
    return;
  }

  globalThis.testHooks = {
    resetDb: async (options?: ResetDbOptions): Promise<ResetDbResult> => {
      const validatedOptions = validateResetDbOptions(options);
      const bootstrapResult = ensureBootstrap();

      await quiesceAndRestore();
      bootstrapResult.imapStateInspector.reset();
      bootstrapResult.smtpServer.reset();
      bootstrapResult.oauthServer.reset();
      bootstrapResult.ollamaServer.reset();

      if (validatedOptions.seedAccount !== false) {
        const seededAccount = seedDefaultTestAccount(bootstrapResult);
        return {
          success: true,
          accountId: seededAccount.accountId,
          email: seededAccount.email,
        };
      }

      return { success: true };
    },

    reloadWindow: (): { success: boolean } => {
      const window = mainWindow;
      if (window !== null && !window.isDestroyed()) {
        const angularEntryPath = getAngularEntryPath();
        void window.loadFile(angularEntryPath).catch((error: unknown) => {
          console.error('[frontend-test-main] Failed to reload Angular entrypoint:', error);
        });
        return { success: true };
      }

      return { success: false };
    },

    injectEmail: async (payload: InjectEmailPayload): Promise<TestHookResponse> => {
      const validatedPayload = validateInjectEmailPayload(payload);
      const bootstrapResult = ensureBootstrap();
      const buffer = Buffer.from(validatedPayload.rfc822, 'base64');

      bootstrapResult.imapStateInspector.injectMessage(
        validatedPayload.mailbox,
        buffer,
        validatedPayload.options,
      );

      return { success: true };
    },

    triggerSync: async (payload: TriggerSyncPayload): Promise<TestHookResponse> => {
      const validatedPayload = validateTriggerSyncPayload(payload);
      const bootstrapResult = ensureBootstrap();
      const window = ensureMainWindow();
      const syncHandler = bootstrapResult.ipcHandlerMap.get('mail:sync-account');

      if (syncHandler === undefined) {
        throw new Error('mail:sync-account IPC handler is not registered.');
      }

      const { priorFolderUpdatedCount, priorQueueUpdateCount } = getSyncEventCounts(validatedPayload.accountId);

      const syncResponse = await Promise.resolve(
        syncHandler({ sender: window.webContents } as IpcMainInvokeEvent, validatedPayload.accountId),
      ) as FrontendIpcResponse<{ queueId: string | null }>;

      if (!syncResponse.success) {
        throw new Error(
          `triggerSync failed: ${syncResponse.error?.code ?? 'unknown'} - ${syncResponse.error?.message ?? ''}`,
        );
      }

      await waitForTriggeredSync(
        validatedPayload.accountId,
        syncResponse.data?.queueId ?? null,
        priorFolderUpdatedCount,
        priorQueueUpdateCount,
      );

      return { success: true };
    },

    // Reserved for Phase 6 compose send-flow tests.
    getSmtpCaptured: async (): Promise<SmtpCapturedResponse> => {
      const bootstrapResult = ensureBootstrap();
      return {
        success: true,
        emails: bootstrapResult.smtpServer.getCapturedEmails(),
      };
    },

    configureOllama: async (config: ConfigureOllamaPayload): Promise<TestHookResponse> => {
      const validatedConfig = validateConfigureOllamaPayload(config);
      const bootstrapResult = ensureBootstrap();

      if (validatedConfig.models !== undefined) {
        bootstrapResult.ollamaServer.setModels(validatedConfig.models.map((modelName, index) => {
          return {
            name: modelName,
            size: 1_000_000_000 + index,
            modified_at: DateTime.now().toISO() ?? '2026-01-01T00:00:00.000Z',
            digest: `sha256:frontend-test-${index}`,
          };
        }));
      }

      configureFakeOllamaResponses(validatedConfig);

      if (validatedConfig.healthy !== undefined) {
        bootstrapResult.ollamaServer.setError('health', !validatedConfig.healthy);
      }

      if (validatedConfig.enableAiChat === true) {
        bootstrapResult.ollamaServer.setEmbedDimension(768);
        bootstrapResult.ollamaServer.setEmbeddings(
          Array.from({ length: 20 }, () => createDeterministicEmbeddingVector(768))
        );
        enableAiChatIndexFixture();
      }

      await triggerOllamaHealthCheck();
      return { success: true };
    },
  };
}

app.whenReady().then(async () => {
  tempDirPath = fs.mkdtempSync(path.join(os.tmpdir(), 'latentmail-frontend-test-'));
  app.setPath('userData', tempDirPath);
  process.env['LATENTMAIL_TEST_MODE'] = '1';

  const databasePath = path.join(tempDirPath, 'latentmail.frontend.test.db');
  bootstrap = await initializeBootstrap({
    databasePath,
    tempDir: tempDirPath,
  });

  registerTestHooks();
  seedDefaultTestAccount(bootstrap);

  mainWindow = await createMainWindow();
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  registerShutdownHandlers();
}).catch(async (error: unknown) => {
  console.error('[frontend-test-main] Failed to start frontend Electron harness:', error);
  await shutdownFrontendHarness();
  app.exit(1);
});
