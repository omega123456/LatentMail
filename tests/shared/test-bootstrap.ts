import { ipcMain, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

import { GmailImapServer } from '../backend/mocks/imap/gmail-imap-server';
import { MessageStore } from '../backend/mocks/imap/message-store';
import { StateInspector } from '../backend/mocks/imap/state-inspector';
import { SmtpCaptureServer } from '../backend/mocks/smtp/smtp-capture-server';
import { FakeOAuthServer } from '../backend/mocks/oauth/fake-oauth-server';
import { FakeOllamaServer } from '../backend/mocks/ollama/fake-ollama-server';

const DEFAULT_TEST_GOOGLE_CLIENT_ID = 'latentmail-test-client-id.apps.googleusercontent.com';

export interface BootstrapOptions {
  databasePath: string;
  tempDir: string;
}

export interface BootstrapResult {
  ipcHandlerMap: Map<string, (...args: unknown[]) => unknown>;
  imapStore: MessageStore;
  imapServer: GmailImapServer;
  imapStateInspector: StateInspector;
  smtpServer: SmtpCaptureServer;
  oauthServer: FakeOAuthServer;
  ollamaServer: FakeOllamaServer;
}

interface ServiceInitializationResult {
  dbService: {
    initialize(): Promise<void>;
    close(): void;
    reopen(databasePath: string): Promise<void>;
  };
  vectorDbService: {
    initialize(): void;
    close(): void;
    reopen(databasePath: string): void;
  };
}

function applyBootstrapEnvironment(databasePath: string): void {
  process.env['DATABASE_PATH'] = databasePath;
  process.env['QUEUE_RETRY_BASE_MS'] = '50';
  process.env['QUEUE_RETRY_MAX_MS'] = '500';
  process.env['OAUTH_TEST_MODE'] = '1';
  process.env['EMBEDDING_INTER_BATCH_DELAY_MS'] = process.env['EMBEDDING_INTER_BATCH_DELAY_MS'] ?? '200';
  process.env['EMBEDDING_IMAP_RECONNECT_DELAYS_MS'] = process.env['EMBEDDING_IMAP_RECONNECT_DELAYS_MS'] ?? '50,100,200';
  process.env['EMBEDDING_OLLAMA_RETRY_DELAYS_MS'] = process.env['EMBEDDING_OLLAMA_RETRY_DELAYS_MS'] ?? '25,50,100';
  process.env['EMBEDDING_WORKER_TERMINATE_DELAY_MS'] = process.env['EMBEDDING_WORKER_TERMINATE_DELAY_MS'] ?? '25';
  process.env['LATENTMAIL_TEST_GOOGLE_CLIENT_ID'] = DEFAULT_TEST_GOOGLE_CLIENT_ID;
}

async function startMockServers(
  imapServer: GmailImapServer,
  smtpServer: SmtpCaptureServer,
  oauthServer: FakeOAuthServer,
  ollamaServer: FakeOllamaServer,
): Promise<void> {
  try {
    const imapPort = await imapServer.start();
    process.env['IMAP_HOST'] = '127.0.0.1';
    process.env['IMAP_PORT'] = String(imapPort);
    process.env['IMAP_SECURE'] = 'false';
    console.log(`[test-main] Fake IMAP server started on port ${imapPort}`);
  } catch (error) {
    console.error('[test-main] Failed to start fake IMAP server:', error);
    throw error;
  }

  try {
    const smtpPort = await smtpServer.start();
    process.env['SMTP_HOST'] = '127.0.0.1';
    process.env['SMTP_PORT'] = String(smtpPort);
    process.env['SMTP_SECURE'] = 'false';
    console.log(`[test-main] Fake SMTP server started on port ${smtpPort}`);
  } catch (error) {
    console.error('[test-main] Failed to start fake SMTP server:', error);
    throw error;
  }

  try {
    const oauthPort = await oauthServer.start();
    const oauthBaseUrl = oauthServer.getBaseUrl();
    process.env['GOOGLE_TOKEN_URL'] = `${oauthBaseUrl}/o/oauth2/token`;
    process.env['GOOGLE_USERINFO_URL'] = `${oauthBaseUrl}/oauth2/v3/userinfo`;
    process.env['GOOGLE_REVOKE_URL'] = `${oauthBaseUrl}/o/oauth2/revoke`;
    process.env['GOOGLE_AUTH_URL'] = `${oauthBaseUrl}/o/oauth2/v2/auth`;
    console.log(`[test-main] Fake OAuth server started on port ${oauthPort}`);
  } catch (error) {
    console.error('[test-main] Failed to start fake OAuth server:', error);
    throw error;
  }

  try {
    const ollamaPort = await ollamaServer.start();
    process.env['OLLAMA_URL'] = ollamaServer.getBaseUrl();
    console.log(`[test-main] Fake Ollama server started on port ${ollamaPort}`);
  } catch (error) {
    console.error('[test-main] Failed to start fake Ollama server:', error);
    throw error;
  }
}

function silenceElectronLogConsoleTransport(): void {
  try {
    const electronLog = require('electron-log/main');
    electronLog.transports.console.level = false;
  } catch {
    // Non-fatal — logging may remain noisy but tests still run
  }
}

async function initializeProductionServices(): Promise<ServiceInitializationResult> {
  const { DatabaseService } = require('../../electron/services/database-service') as typeof import('../../electron/services/database-service');
  const dbService = DatabaseService.getInstance();

  try {
    await dbService.initialize();
    console.log('[test-main] DatabaseService initialized');
  } catch (error) {
    console.error('[test-main] DatabaseService initialization failed:', error);
    throw error;
  }

  const { LoggerService } = require('../../electron/services/logger-service') as typeof import('../../electron/services/logger-service');
  try {
    LoggerService.getInstance().initialize();
    console.log('[test-main] LoggerService re-initialized');
  } catch (error) {
    console.warn('[test-main] LoggerService re-initialization failed (non-fatal):', error);
  }

  silenceElectronLogConsoleTransport();

  const { VectorDbService } = require('../../electron/services/vector-db-service') as typeof import('../../electron/services/vector-db-service');
  const vectorDbService = VectorDbService.getInstance();
  try {
    vectorDbService.initialize();
    console.log('[test-main] VectorDbService initialized');
  } catch (error) {
    console.warn('[test-main] VectorDbService initialization failed (non-fatal):', error);
  }

  try {
    const { EmbeddingService } = require('../../electron/services/embedding-service') as typeof import('../../electron/services/embedding-service');
    EmbeddingService.getInstance(vectorDbService);
    console.log('[test-main] EmbeddingService initialized');
  } catch (error) {
    console.warn('[test-main] EmbeddingService initialization failed (non-fatal):', error);
  }

  return { dbService, vectorDbService };
}

function patchIpcMainForTesting(
  ipcHandlerMap: Map<string, (...args: unknown[]) => unknown>,
): void {
  const { patchIpcMainForActivityTracking } = require('../../electron/ipc/ipc-activity-tracker') as typeof import('../../electron/ipc/ipc-activity-tracker');
  patchIpcMainForActivityTracking();
  console.log('[test-main] ipcMain activity tracking patch applied');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activityTrackedHandle = (ipcMain as any).handle.bind(ipcMain) as (
    channel: string,
    listener: (...args: unknown[]) => unknown,
  ) => void;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (ipcMain as any).handle = (
    channel: string,
    listener: (...args: unknown[]) => unknown,
  ): void => {
    ipcHandlerMap.set(channel, listener);
    const wrappedListener = (...args: unknown[]) => {
      const overrideState = globalThis as {
        __LATENTMAIL_IPC_OVERRIDES__?: Map<string, Array<{ response?: unknown; throwMessage?: string; once?: boolean }>>;
      };
      const overrideQueue = overrideState.__LATENTMAIL_IPC_OVERRIDES__?.get(channel);
      const override = overrideQueue?.[0];

      if (override !== undefined) {
        if (override.once === true) {
          overrideQueue?.shift();
          if (overrideQueue?.length === 0) {
            overrideState.__LATENTMAIL_IPC_OVERRIDES__?.delete(channel);
          }
        }

        if (typeof override.throwMessage === 'string' && override.throwMessage.length > 0) {
          throw new Error(override.throwMessage);
        }

        return override.response;
      }

      return listener(...args);
    };

    activityTrackedHandle(channel, wrappedListener);
  };

  const { registerAllIpcHandlers } = require('../../electron/ipc') as typeof import('../../electron/ipc');
  registerAllIpcHandlers();
  console.log('[test-main] All IPC handlers registered. Total channels:', ipcHandlerMap.size);
}

function stopOllamaHealthChecks(): void {
  try {
    const { OllamaService } = require('../../electron/services/ollama-service') as typeof import('../../electron/services/ollama-service');
    OllamaService.getInstance().stopHealthChecks();
    console.log('[test-main] OllamaService health checks stopped');
  } catch (error) {
    console.warn('[test-main] Failed to stop OllamaService health checks (non-fatal):', error);
  }
}

function registerProtocolHandlers(): void {
  const { getBimiCacheDir } = require('../../electron/ipc/bimi-ipc') as typeof import('../../electron/ipc/bimi-ipc');
  const { getAvatarCacheDir } = require('../../electron/services/avatar-cache-service') as typeof import('../../electron/services/avatar-cache-service');

  protocol.handle('bimi-logo', (request) => {
    const url = new URL(request.url);
    const filename = url.hostname;
    if (!/^[a-f0-9]{32}\.(svg|png)$/.test(filename)) {
      return new Response('Forbidden', { status: 403 });
    }
    const filePath = path.join(getBimiCacheDir(), filename);
    try {
      const data = fs.readFileSync(filePath);
      const contentType = filename.endsWith('.png') ? 'image/png' : 'image/svg+xml';
      return new Response(data, { headers: { 'Content-Type': contentType } });
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  });

  protocol.handle('account-avatar', (request) => {
    try {
      const url = new URL(request.url);
      const rawFilename = url.hostname || url.pathname.replace(/^\//, '');
      const filename = rawFilename.trim();
      if (!/^[0-9]+\.(png|jpg|jpeg|webp)$/i.test(filename)) {
        return new Response('Forbidden', { status: 403 });
      }
      const filePath = path.join(getAvatarCacheDir(), filename);
      try {
        const data = fs.readFileSync(filePath);
        const lowerFilename = filename.toLowerCase();
        let contentType = 'image/jpeg';
        if (lowerFilename.endsWith('.png')) {
          contentType = 'image/png';
        } else if (lowerFilename.endsWith('.webp')) {
          contentType = 'image/webp';
        }
        return new Response(data, { headers: { 'Content-Type': contentType } });
      } catch {
        return new Response('Not Found', { status: 404 });
      }
    } catch {
      return new Response('Bad Request', { status: 400 });
    }
  });
}

async function createDatabaseSnapshots(
  dbService: ServiceInitializationResult['dbService'],
  vectorDbService: ServiceInitializationResult['vectorDbService'],
  databasePath: string,
  tempDir: string,
): Promise<void> {
  try {
    const templatePath = databasePath.replace('.test.db', '.test.template.db');

    dbService.close();
    fs.copyFileSync(databasePath, templatePath);

    const writeAheadLogPath = databasePath + '-wal';
    const sharedMemoryPath = databasePath + '-shm';
    if (fs.existsSync(writeAheadLogPath)) {
      fs.copyFileSync(writeAheadLogPath, templatePath + '-wal');
    }
    if (fs.existsSync(sharedMemoryPath)) {
      fs.copyFileSync(sharedMemoryPath, templatePath + '-shm');
    }

    await dbService.reopen(databasePath);
    console.log('[test-main] Main DB template snapshot created:', templatePath);

    const vectorDbPath = path.join(tempDir, 'latentmail-vectors.db');
    if (fs.existsSync(vectorDbPath)) {
      const vectorTemplatePath = path.join(tempDir, 'latentmail-vectors.test.template.db');

      vectorDbService.close();
      fs.copyFileSync(vectorDbPath, vectorTemplatePath);

      const vectorWriteAheadLogPath = vectorDbPath + '-wal';
      const vectorSharedMemoryPath = vectorDbPath + '-shm';
      if (fs.existsSync(vectorWriteAheadLogPath)) {
        fs.copyFileSync(vectorWriteAheadLogPath, vectorTemplatePath + '-wal');
      }
      if (fs.existsSync(vectorSharedMemoryPath)) {
        fs.copyFileSync(vectorSharedMemoryPath, vectorTemplatePath + '-shm');
      }

      vectorDbService.reopen(vectorDbPath);
      console.log('[test-main] Vector DB template snapshot created:', vectorTemplatePath);
    }
  } catch (error) {
    console.warn('[test-main] Failed to create DB template snapshots (non-fatal):', error);
  }
}

async function stopMockServers(
  imapServer: GmailImapServer,
  smtpServer: SmtpCaptureServer,
  oauthServer: FakeOAuthServer,
  ollamaServer: FakeOllamaServer,
): Promise<void> {
  await Promise.allSettled([
    imapServer.stop(),
    smtpServer.stop(),
    oauthServer.stop(),
    ollamaServer.stop(),
  ]);
}

export async function initializeBootstrap(options: BootstrapOptions): Promise<BootstrapResult> {
  const imapStore = new MessageStore();
  const imapServer = new GmailImapServer(imapStore);
  const imapStateInspector = new StateInspector(imapServer, imapStore);
  const smtpServer = new SmtpCaptureServer();
  const oauthServer = new FakeOAuthServer();
  const ollamaServer = new FakeOllamaServer();
  const ipcHandlerMap = new Map<string, (...args: unknown[]) => unknown>();

  try {
    applyBootstrapEnvironment(options.databasePath);
    await startMockServers(imapServer, smtpServer, oauthServer, ollamaServer);
    silenceElectronLogConsoleTransport();
    const { dbService, vectorDbService } = await initializeProductionServices();
    patchIpcMainForTesting(ipcHandlerMap);
    stopOllamaHealthChecks();
    registerProtocolHandlers();
    await createDatabaseSnapshots(dbService, vectorDbService, options.databasePath, options.tempDir);

    return {
      ipcHandlerMap,
      imapStore,
      imapServer,
      imapStateInspector,
      smtpServer,
      oauthServer,
      ollamaServer,
    };
  } catch (error) {
    await stopMockServers(imapServer, smtpServer, oauthServer, ollamaServer);
    throw error;
  }
}
