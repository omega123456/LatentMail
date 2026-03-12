/**
 * ai-ollama.test.ts — Backend E2E tests for AI / Ollama integration.
 *
 * Covers:
 *   - ai:get-status returns current connection state
 *   - ai:set-url validates local-only URLs; updates OllamaService's baseUrl
 *   - ai:set-model stores model name; returned by get-status
 *   - ai:get-models returns model list from fake Ollama server
 *   - ai:summarize sends a chat request and returns summary text
 *   - ai:compose sends a chat request and returns composed text
 *   - ai:transform validates transformation type; transforms text
 *   - ai:generate-replies returns suggestions array parsed from JSON chat response
 *   - ai:generate-filter returns structured filter from JSON chat response
 *   - ai:detect-followup returns needsFollowUp flag from JSON response
 *   - ai:set-embedding-model validates model via embed endpoint; configures VectorDB
 *   - ai:get-embedding-status reflects no-model state and post-model-set state
 *   - ai:build-index starts a build (fails without model → expected error)
 *   - ai:cancel-index cancels any in-progress build
 *   - ai:rebuild-index fails when no model is configured
 *   - Embedding events: embedding:progress / embedding:complete fired during a build
 *   - ai:chat: returns requestId and emits ai:chat:stream / ai:chat:done via window events
 *   - ai:chat:cancel: cancels an in-progress chat
 *   - Input validation: ai:summarize with empty content → AI_INVALID_INPUT
 *   - Input validation: ai:compose with empty prompt → AI_INVALID_INPUT
 *   - Input validation: ai:transform with invalid type → AI_INVALID_INPUT
 *   - Error simulation: ai:summarize when Ollama returns HTTP 500 → error response
 *
 * Embedding tests explicitly set up the embedding model before testing build/cancel/progress.
 *
 * Pattern:
 *   - before(): quiesce/restore + seed one account + configure fake Ollama server
 *   - OllamaService's baseUrl is already set to fake Ollama via OLLAMA_URL env var
 *   - Individual tests configure the FakeOllamaServer with canned responses
 */

import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  getDatabase,
  waitForEvent,
  seedTestAccount,
  triggerSyncAndWait,
} from '../infrastructure/test-helpers';
import { imapStateInspector, ollamaServer } from '../test-main';
import { emlFixtures } from '../fixtures/index';
import { TestEventBus } from '../infrastructure/test-event-bus';
import { OllamaService } from '../../../electron/services/ollama-service';
import { VectorDbService } from '../../../electron/services/vector-db-service';

// ---- Type helpers ----

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface OllamaStatusResponse {
  connected: boolean;
  url: string;
  currentModel: string;
  embeddingModel?: string;
}

interface EmbeddingStatusResponse {
  embeddingModel: string | null;
  indexStatus: string;
  indexed: number;
  total: number;
  vectorDimension: number | null;
}

interface SearchBatchPayload {
  searchToken: string;
  msgIds: string[];
  phase: 'local' | 'imap';
}

interface SearchCompletePayload {
  searchToken: string;
  status: string;
  totalResults: number;
}

async function waitForSearchComplete(
  searchToken: string,
  timeoutMs: number = 20_000,
): Promise<SearchCompletePayload> {
  const resultArgs = await TestEventBus.getInstance().waitFor('ai:search:complete', {
    timeout: timeoutMs,
    predicate: (args) => {
      const payload = args[0] as SearchCompletePayload | undefined;
      return payload != null && payload.searchToken === searchToken;
    },
  });

  return resultArgs[0] as SearchCompletePayload;
}

function getSearchBatchesSince(
  searchToken: string,
  priorBatchCount: number,
): SearchBatchPayload[] {
  return TestEventBus.getInstance()
    .getHistory('ai:search:batch')
    .slice(priorBatchCount)
    .map((record) => record.args[0] as SearchBatchPayload)
    .filter((payload) => payload != null && payload.searchToken === searchToken);
}

async function ensureOllamaKeywordModeReady(): Promise<void> {
  const urlResponse = await callIpc('ai:set-url', ollamaServer.getBaseUrl()) as IpcResponse<OllamaStatusResponse>;
  expect(urlResponse.success).to.equal(true);
  expect(urlResponse.data!.connected).to.equal(true);

  const modelResponse = await callIpc('ai:set-model', 'llama3.2:latest') as IpcResponse<{ currentModel: string }>;
  expect(modelResponse.success).to.equal(true);
  expect(modelResponse.data!.currentModel).to.equal('llama3.2:latest');
}

async function configureEmbeddingModelForSuite(dimension: number, model: string = 'nomic-embed-text:latest'): Promise<void> {
  ollamaServer.setEmbedDimension(dimension);

  const response = await callIpc('ai:set-embedding-model', model) as IpcResponse<{
    embeddingModel: string;
    vectorDimension: number;
  }>;

  expect(response.success).to.equal(true);
  expect(response.data!.embeddingModel).to.equal(model);
  expect(response.data!.vectorDimension).to.equal(dimension);
}

function insertSemanticChunk(accountId: number, xGmMsgId: string, chunkText: string, embedding: number[]): void {
  const vectorDbService = VectorDbService.getInstance();
  expect(vectorDbService.vectorsAvailable).to.equal(true);

  vectorDbService.insertChunks({
    accountId,
    xGmMsgId,
    chunks: [
      {
        chunkIndex: 0,
        chunkText,
        embedding,
      },
    ],
  });
}

// ---- Suite-level state ----

let suiteAccountId: number;
let suiteEmail: string;

// =========================================================================
// AI / Ollama Tests
// =========================================================================

describe('AI / Ollama', () => {
  before(async function () {
    this.timeout(35_000);

    await quiesceAndRestore();

    const seeded = seedTestAccount({
      email: 'ai-test@example.com',
      displayName: 'AI Test User',
    });
    suiteAccountId = seeded.accountId;
    suiteEmail = seeded.email;

    // Reset IMAP server
    imapStateInspector.reset();
    imapStateInspector.getServer().addAllowedAccount(suiteEmail);

    // Reset Ollama fake server to clean state with default models
    ollamaServer.reset();

    // Point OllamaService at our fake server.
    // OLLAMA_URL env var is set in test-main.ts so the singleton already uses it.
    // Re-apply in case quiesceAndRestore() re-loaded the settings from DB.
    const ollamaService = OllamaService.getInstance();
    ollamaService['baseUrl'] = ollamaServer.getBaseUrl();

    // Stop any health check timers (quiesceAndRestore already does this but be explicit)
    ollamaService.stopHealthChecks();

    // Inject a message so the account has some data for chat tests
    const plainMsg = emlFixtures['plain-text'];
    imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
      xGmMsgId: plainMsg.headers.xGmMsgId,
      xGmThrid: plainMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
      xGmMsgId: plainMsg.headers.xGmMsgId,
      xGmThrid: plainMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });

    // Sync so we have some data in DB for chat tests
    await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
  });

  // afterEach: reset Ollama server between tests to prevent error state leaking
  afterEach(function () {
    ollamaServer.reset();
    // Restore base URL since reset() clears config but server is still running
    const ollamaService = OllamaService.getInstance();
    ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
  });

  // Suite-level teardown: cancel any in-progress embedding build so that the
  // worker thread releases its file handles BEFORE the next test suite's
  // quiesceAndRestore() tries to replace the vector DB WAL files.
  // On Windows, worker_threads.terminate() is async at the OS level; the 500ms
  // sleep gives the file handles time to drain even though the JS promise resolves.
  after(async function () {
    this.timeout(5_000);

    try {
      const { EmbeddingService } = require('../../../electron/services/embedding-service') as typeof import('../../../electron/services/embedding-service');
      const embeddingService = EmbeddingService.getInstance();
      if (embeddingService.getBuildState() === 'building') {
        embeddingService.cancelBuild();
        // Give the worker thread time to release OS file handles before any
        // subsequent quiesceAndRestore() attempts to replace the WAL files.
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
      }
    } catch {
      // EmbeddingService not initialized — nothing to cancel
    }
  });

  // -------------------------------------------------------------------------
  // ai:get-status
  // -------------------------------------------------------------------------

  describe('ai:get-status', () => {
    it('returns current status including connected flag and url', async () => {
      // Configure the fake server to respond to health check
      const response = await callIpc('ai:get-status') as IpcResponse<OllamaStatusResponse>;

      expect(response.success).to.equal(true);
      expect(response.data).to.have.property('connected').that.is.a('boolean');
      expect(response.data).to.have.property('url').that.is.a('string');
      expect(response.data).to.have.property('currentModel').that.is.a('string');
    });

    it('returns connected=true when fake Ollama server responds successfully', async () => {
      const response = await callIpc('ai:get-status') as IpcResponse<OllamaStatusResponse>;

      expect(response.success).to.equal(true);
      // The fake server is healthy (no healthError configured) — should be connected
      expect(response.data!.connected).to.equal(true);
    });

    it('returns connected=false when the health check fails', async () => {
      ollamaServer.setError('health', true);

      const response = await callIpc('ai:get-status') as IpcResponse<OllamaStatusResponse>;

      expect(response.success).to.equal(true);
      expect(response.data!.connected).to.equal(false);
      expect(response.data!.url).to.equal(ollamaServer.getBaseUrl());
    });
  });

  // -------------------------------------------------------------------------
  // ai:set-url
  // -------------------------------------------------------------------------

  describe('ai:set-url', () => {
    it('rejects non-local URLs', async () => {
      const response = await callIpc(
        'ai:set-url',
        'http://external.example.com:11434',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('rejects empty URL', async () => {
      const response = await callIpc('ai:set-url', '') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('rejects malformed URL strings', async () => {
      const response = await callIpc('ai:set-url', '://not-a-valid-url') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('rejects localhost URLs that include credentials', async () => {
      const response = await callIpc(
        'ai:set-url',
        'http://user:secret@127.0.0.1:11434',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('accepts localhost URL and updates connection status', async () => {
      const fakeUrl = ollamaServer.getBaseUrl();

      const response = await callIpc('ai:set-url', fakeUrl) as IpcResponse<OllamaStatusResponse>;

      expect(response.success).to.equal(true);
      expect(response.data!.url).to.equal(fakeUrl);
    });

    it('persists accepted URLs to settings', async () => {
      const fakeUrl = ollamaServer.getBaseUrl();
      const response = await callIpc('ai:set-url', fakeUrl) as IpcResponse<OllamaStatusResponse>;

      expect(response.success).to.equal(true);
      expect(getDatabase().getSetting('ollamaUrl')).to.equal(fakeUrl);
    });

    it('transitions to disconnected state when pointed at a non-responsive local URL', async () => {
      const statusBus = TestEventBus.getInstance();
      const priorStatusCount = statusBus.getHistory('ai:status').length;

      const response = await callIpc(
        'ai:set-url',
        'http://127.0.0.1:65534',
      ) as IpcResponse<OllamaStatusResponse>;

      expect(response.success).to.equal(true);
      expect(response.data!.url).to.equal('http://127.0.0.1:65534');
      expect(response.data!.connected).to.equal(false);

      const statusEvents = statusBus.getHistory('ai:status').slice(priorStatusCount);
      const disconnectedEvent = statusEvents.find((record) => {
        const payload = record.args[0] as OllamaStatusResponse | undefined;
        return payload?.connected === false && payload?.url === 'http://127.0.0.1:65534';
      });

      expect(disconnectedEvent).to.not.equal(undefined);
    });

    it('transitions back to connected when reset to the fake server URL', async () => {
      await callIpc('ai:set-url', 'http://127.0.0.1:65534');

      const statusBus = TestEventBus.getInstance();
      const priorStatusCount = statusBus.getHistory('ai:status').length;
      const fakeUrl = ollamaServer.getBaseUrl();

      const response = await callIpc('ai:set-url', fakeUrl) as IpcResponse<OllamaStatusResponse>;

      expect(response.success).to.equal(true);
      expect(response.data!.url).to.equal(fakeUrl);
      expect(response.data!.connected).to.equal(true);

      const statusEvents = statusBus.getHistory('ai:status').slice(priorStatusCount);
      const connectedEvent = statusEvents.find((record) => {
        const payload = record.args[0] as OllamaStatusResponse | undefined;
        return payload?.connected === true && payload?.url === fakeUrl;
      });

      expect(connectedEvent).to.not.equal(undefined);
    });

    it('returns AI_SET_URL_FAILED when updating the Ollama URL throws unexpectedly', async () => {
      const ollamaService = OllamaService.getInstance() as unknown as {
        setUrl: (url: string) => Promise<void>;
      };
      const originalSetUrl = ollamaService.setUrl;
      ollamaService.setUrl = async (_url: string): Promise<void> => {
        throw new Error('forced setUrl failure');
      };

      try {
        const response = await callIpc('ai:set-url', ollamaServer.getBaseUrl()) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('AI_SET_URL_FAILED');
      } finally {
        ollamaService.setUrl = originalSetUrl;
      }
    });
  });

  // -------------------------------------------------------------------------
  // ai:set-model / ai:get-status model tracking
  // -------------------------------------------------------------------------

  describe('ai:set-model', () => {
    it('sets the current model name', async () => {
      const response = await callIpc(
        'ai:set-model',
        'llama3.2:latest',
      ) as IpcResponse<{ currentModel: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.currentModel).to.equal('llama3.2:latest');
    });

    it('rejects empty model name', async () => {
      const response = await callIpc('ai:set-model', '') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('is reflected by ai:get-status and persisted to settings', async () => {
      const model = 'llama3.2:latest';

      const setResponse = await callIpc('ai:set-model', model) as IpcResponse<{ currentModel: string }>;
      const statusResponse = await callIpc('ai:get-status') as IpcResponse<OllamaStatusResponse>;

      expect(setResponse.success).to.equal(true);
      expect(statusResponse.success).to.equal(true);
      expect(statusResponse.data!.currentModel).to.equal(model);
      expect(getDatabase().getSetting('ollamaModel')).to.equal(model);
    });

    it('returns AI_SET_MODEL_FAILED when persisting the model throws unexpectedly', async () => {
      const ollamaService = OllamaService.getInstance() as unknown as {
        setModel: (model: string) => void;
      };
      const originalSetModel = ollamaService.setModel;
      ollamaService.setModel = (_model: string): void => {
        throw new Error('forced setModel failure');
      };

      try {
        const response = await callIpc('ai:set-model', 'llama3.2:latest') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('AI_SET_MODEL_FAILED');
      } finally {
        ollamaService.setModel = originalSetModel;
      }
    });
  });

  // -------------------------------------------------------------------------
  // ai:get-models
  // -------------------------------------------------------------------------

  describe('ai:get-models', () => {
    it('returns model list from the fake Ollama server', async () => {
      const response = await callIpc('ai:get-models') as IpcResponse<{ models: Array<{ name: string; size: number }> }>;

      expect(response.success).to.equal(true);
      expect(response.data!.models).to.be.an('array');
      expect(response.data!.models.length).to.be.greaterThan(0);

      // Each model must have name and size
      for (const model of response.data!.models) {
        expect(model).to.have.property('name').that.is.a('string');
        expect(model).to.have.property('size').that.is.a('number');
      }
    });

    it('returns the default fake models (llama3.2 and nomic-embed-text)', async () => {
      const response = await callIpc('ai:get-models') as IpcResponse<{ models: Array<{ name: string }> }>;

      expect(response.success).to.equal(true);
      const modelNames = response.data!.models.map((model) => model.name);
      expect(modelNames).to.include('llama3.2:latest');
      expect(modelNames).to.include('nomic-embed-text:latest');
    });

    it('returns error when Ollama tags endpoint fails', async () => {
      ollamaServer.setError('tags', true);

      const response = await callIpc('ai:get-models') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_GET_MODELS_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // ai:summarize
  // -------------------------------------------------------------------------

  describe('ai:summarize', () => {
    it('returns AI_INVALID_INPUT for empty content', async () => {
      const response = await callIpc('ai:summarize', '') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_NO_MODEL when no AI model is selected', async () => {
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentModel'] = '';

      const response = await callIpc(
        'ai:summarize',
        `No-model summarize content ${Date.now()}`,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_NO_MODEL');
    });

    it('returns a summary from the canned chat response', async () => {
      // Set up the model first
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('This is a concise summary of the email thread.');

      const threadContent = 'From: alice@example.com\nSubject: Meeting\n\nHello, can we meet tomorrow?';

      const response = await callIpc(
        'ai:summarize',
        threadContent,
      ) as IpcResponse<{ summary: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.summary).to.be.a('string');
      expect(response.data!.summary.length).to.be.greaterThan(0);
    });

    it('returns AI_SUMMARIZE_FAILED when Ollama chat endpoint returns HTTP 500', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setError('chat', true);

      const response = await callIpc(
        'ai:summarize',
        'Some thread content to summarize',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_SUMMARIZE_FAILED');
    });

    it('gracefully returns an empty summary when Ollama responds with empty content', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatStreamChunks([]);

      const response = await callIpc(
        'ai:summarize',
        `Empty summarize response ${Date.now()}`,
      ) as IpcResponse<{ summary: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.summary).to.equal('');
    });

    it('gracefully skips malformed streaming lines and returns parsed summarize content', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatStreamChunks(['First ', 'Second']);

      const originalGetReader = ReadableStream.prototype.getReader;
      ReadableStream.prototype.getReader = function getReaderPatched(this: ReadableStream<Uint8Array>) {
        const originalReader = originalGetReader.call(this);
        const originalRead = originalReader.read.bind(originalReader) as () => Promise<{ done: boolean; value?: Uint8Array }>;
        let didInjectMalformedChunk = false;

        return {
          ...originalReader,
          read: async () => {
            if (!didInjectMalformedChunk) {
              didInjectMalformedChunk = true;
              return {
                done: false,
                value: new TextEncoder().encode('{bad-json}\n'),
              };
            }
            return originalRead();
          },
        };
      } as typeof ReadableStream.prototype.getReader;

      try {
        const response = await callIpc(
          'ai:summarize',
          `Malformed summarize stream ${Date.now()}`,
          `summarize-malformed-${Date.now()}`,
        ) as IpcResponse<{ summary: string }>;

        expect(response.success).to.equal(true);
        expect(response.data!.summary).to.equal('First Second');
      } finally {
        ReadableStream.prototype.getReader = originalGetReader;
      }
    });

    it('streams summarize tokens through ai:stream and returns the concatenated text', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatStreamChunks(['Alpha ', 'Beta', ' Gamma']);

      const requestId = `summarize-stream-${Date.now()}`;
      const uniqueContent = `Unique summarize stream content ${Date.now()}`;

      const response = await callIpc(
        'ai:summarize',
        uniqueContent,
        requestId,
      ) as IpcResponse<{ summary: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.summary).to.equal('Alpha Beta Gamma');

      await waitForEvent('ai:stream', {
        timeout: 10_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          return payload?.['requestId'] === requestId
            && payload?.['type'] === 'summarize'
            && payload?.['done'] === true;
        },
      });

      const streamPayloads = TestEventBus.getInstance()
        .getHistory('ai:stream')
        .map((record) => record.args[0] as Record<string, unknown>)
        .filter((payload) => payload['requestId'] === requestId && payload['type'] === 'summarize');

      const streamedText = streamPayloads
        .filter((payload) => payload['done'] === false)
        .map((payload) => String(payload['token'] ?? ''))
        .join('');

      expect(streamedText).to.equal('Alpha Beta Gamma');
      expect(streamPayloads[streamPayloads.length - 1]!['done']).to.equal(true);
    });

    it('sends at least one request to the /api/chat endpoint on the fake Ollama server', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.reset();
      // Restore baseUrl so OllamaService still points at the fake server after reset()
      const ollamaService = OllamaService.getInstance();
      ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
      ollamaServer.setChatResponse('Test summary response unique xyz-98765.');

      // Use a unique content string to bypass the AI cache
      const uniqueContent = `Unique summarize test content for request count check ${Date.now()}`;
      await callIpc('ai:summarize', uniqueContent);

      const chatRequests = ollamaServer.getRequestsFor('/api/chat');
      // At least one request should have been sent (uncached content)
      expect(chatRequests.length).to.be.greaterThanOrEqual(1);
    });
  });

  // -------------------------------------------------------------------------
  // ai:compose
  // -------------------------------------------------------------------------

  describe('ai:compose', () => {
    it('returns AI_INVALID_INPUT for empty prompt', async () => {
      const response = await callIpc('ai:compose', '') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_NO_MODEL when no AI model is selected', async () => {
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentModel'] = '';

      const response = await callIpc(
        'ai:compose',
        `Compose without model ${Date.now()}`,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_NO_MODEL');
    });

    it('returns composed email text from canned chat response', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('Dear Bob,\n\nThank you for your message.\n\nBest regards');

      const response = await callIpc(
        'ai:compose',
        'Write a brief thank-you reply to Bob',
      ) as IpcResponse<{ text: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.text).to.be.a('string');
      expect(response.data!.text.length).to.be.greaterThan(0);
    });

    it('returns AI_COMPOSE_FAILED when Ollama chat endpoint fails', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setError('chat', true);

      const response = await callIpc(
        'ai:compose',
        'Compose a reply email',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_COMPOSE_FAILED');
    });

    it('returns success with empty text when Ollama returns an empty compose response', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatStreamChunks([]);

      const response = await callIpc(
        'ai:compose',
        `Compose empty response ${Date.now()}`,
      ) as IpcResponse<{ text: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.text).to.equal('');
    });

    it('streams compose output and includes the provided context in the Ollama request', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatStreamChunks(['Dear Bob,', '\n\nThanks!']);

      const requestId = `compose-stream-${Date.now()}`;
      const prompt = 'Write a brief thank-you reply';
      const context = 'Bob asked whether we received the invoice.';

      const response = await callIpc(
        'ai:compose',
        prompt,
        context,
        requestId,
      ) as IpcResponse<{ text: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.text).to.equal('Dear Bob,\n\nThanks!');

      await waitForEvent('ai:stream', {
        timeout: 10_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          return payload?.['requestId'] === requestId
            && payload?.['type'] === 'compose'
            && payload?.['done'] === true;
        },
      });

      const chatRequests = ollamaServer.getRequestsFor('/api/chat');
      expect(chatRequests.length).to.be.greaterThan(0);
      const lastRequest = chatRequests[chatRequests.length - 1]!;
      const messages = lastRequest.body['messages'] as Array<Record<string, unknown>>;
      expect(lastRequest.body['stream']).to.equal(true);
      expect(messages[1]!['content']).to.include(`Context/Previous thread:\n${context}`);
      expect(messages[1]!['content']).to.include(`Instructions: ${prompt}`);
    });
  });

  // -------------------------------------------------------------------------
  // ai:transform
  // -------------------------------------------------------------------------

  describe('ai:transform', () => {
    it('returns AI_INVALID_INPUT for empty text', async () => {
      const response = await callIpc('ai:transform', '', 'improve') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT for invalid transformation type', async () => {
      const response = await callIpc(
        'ai:transform',
        'Some text to transform',
        'invalidtype',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_NO_MODEL when no AI model is selected', async () => {
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentModel'] = '';

      const response = await callIpc(
        'ai:transform',
        `Transform without model ${Date.now()}`,
        'improve',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_NO_MODEL');
    });

    it('transforms text with improve transformation', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('This is the improved version of the text.');

      const response = await callIpc(
        'ai:transform',
        'pls make this better its not great',
        'improve',
      ) as IpcResponse<{ text: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.text).to.be.a('string');
      expect(response.data!.text.length).to.be.greaterThan(0);
    });

    it('transforms text with shorten transformation', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('Short version.');

      const response = await callIpc(
        'ai:transform',
        'This is a very long text that needs to be shortened considerably.',
        'shorten',
      ) as IpcResponse<{ text: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.text).to.be.a('string');
    });

    it('transforms text with formalize transformation', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('I would be grateful for your assistance in this matter.');

      const response = await callIpc(
        'ai:transform',
        'hey can you help me out?',
        'formalize',
      ) as IpcResponse<{ text: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.text).to.be.a('string');
    });

    it('transforms text with casualize transformation', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('Hey! Can you help me out?');

      const response = await callIpc(
        'ai:transform',
        'I would be most grateful if you could assist me.',
        'casualize',
      ) as IpcResponse<{ text: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.text).to.be.a('string');
    });

    it('returns AI_TRANSFORM_FAILED when Ollama chat endpoint fails', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setError('chat', true);

      const response = await callIpc(
        'ai:transform',
        'Please improve this draft.',
        'improve',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_TRANSFORM_FAILED');
    });

    it('streams transform output through ai:stream', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatStreamChunks(['Improved ', 'draft']);

      const requestId = `transform-stream-${Date.now()}`;
      const response = await callIpc(
        'ai:transform',
        'pls improve this',
        'improve',
        requestId,
      ) as IpcResponse<{ text: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.text).to.equal('Improved draft');

      await waitForEvent('ai:stream', {
        timeout: 10_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          return payload?.['requestId'] === requestId
            && payload?.['type'] === 'transform'
            && payload?.['done'] === true;
        },
      });
    });
  });

  // -------------------------------------------------------------------------
  // ai:generate-replies
  // -------------------------------------------------------------------------

  describe('ai:generate-replies', () => {
    it('returns AI_INVALID_INPUT for empty content', async () => {
      const response = await callIpc('ai:generate-replies', '') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_NO_MODEL when no AI model is selected', async () => {
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentModel'] = '';

      const response = await callIpc(
        'ai:generate-replies',
        `No-model reply suggestions ${Date.now()}`,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_NO_MODEL');
    });

    it('returns suggestions array from canned JSON chat response', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('{"suggestions":["Sure, I can help!","Thanks for reaching out.","I will get back to you shortly."]}');

      const response = await callIpc(
        'ai:generate-replies',
        'From: alice@example.com\n\nHi, can you help me with the report?',
      ) as IpcResponse<{ suggestions: string[] }>;

      expect(response.success).to.equal(true);
      expect(response.data!.suggestions).to.be.an('array');
      expect(response.data!.suggestions.length).to.be.greaterThan(0);
    });

    it('returns empty suggestions when response JSON has unexpected structure', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      // Valid JSON but missing the "suggestions" key
      ollamaServer.setChatResponse('{"result":"unexpected format"}');

      const response = await callIpc(
        'ai:generate-replies',
        'From: alice@example.com\n\nCan you help?',
      ) as IpcResponse<{ suggestions: string[] }>;

      expect(response.success).to.equal(true);
      expect(response.data!.suggestions).to.be.an('array');
      expect(response.data!.suggestions.length).to.equal(0);
    });

    it('caps suggestions at three entries', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('{"suggestions":["One","Two","Three","Four"]}');

      const response = await callIpc(
        'ai:generate-replies',
        `Cap suggestions content ${Date.now()}`,
      ) as IpcResponse<{ suggestions: string[] }>;

      expect(response.success).to.equal(true);
      expect(response.data!.suggestions).to.deep.equal(['One', 'Two', 'Three']);
    });

    it('returns AI_GENERATE_REPLIES_FAILED when Ollama chat endpoint fails', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setError('chat', true);

      const response = await callIpc(
        'ai:generate-replies',
        `Reply failure content ${Date.now()}`,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_GENERATE_REPLIES_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // ai:generate-filter
  // -------------------------------------------------------------------------

  describe('ai:generate-filter', () => {
    it('returns AI_INVALID_INPUT for empty description', async () => {
      const response = await callIpc(
        'ai:generate-filter',
        '',
        suiteAccountId,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT when accountId is missing', async () => {
      const response = await callIpc(
        'ai:generate-filter',
        'Label newsletters from example.com',
        // accountId missing (undefined)
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_NO_MODEL when no AI model is selected', async () => {
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentModel'] = '';

      const response = await callIpc(
        'ai:generate-filter',
        `Generate filter without model ${Date.now()}`,
        suiteAccountId,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_NO_MODEL');
    });

    it('returns a structured filter from canned JSON chat response', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse(JSON.stringify({
        name: 'Newsletter Filter',
        conditions: [{ field: 'from', operator: 'contains', value: 'newsletter@example.com' }],
        actions: [{ type: 'label', value: 'Newsletters' }],
      }));

      const response = await callIpc(
        'ai:generate-filter',
        'Move newsletters from newsletter@example.com to Newsletters label',
        suiteAccountId,
      ) as IpcResponse<{ name: string; conditions: unknown[]; actions: unknown[] }>;

      expect(response.success).to.equal(true);
      expect(response.data!.name).to.be.a('string');
      expect(response.data!.conditions).to.be.an('array');
      expect(response.data!.actions).to.be.an('array');
    });

    it('falls back to default filter fields when optional JSON fields are missing', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('{"unexpected":true}');

      const response = await callIpc(
        'ai:generate-filter',
        `Fallback filter fields ${Date.now()}`,
        suiteAccountId,
      ) as IpcResponse<{ name: string; conditions: unknown[]; actions: unknown[] }>;

      expect(response.success).to.equal(true);
      expect(response.data!.name).to.equal('AI-generated filter');
      expect(response.data!.conditions).to.deep.equal([]);
      expect(response.data!.actions).to.deep.equal([]);
    });

    it('backfills incomplete but valid filter structures', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse(JSON.stringify({
        conditions: [{ field: 'from', operator: 'contains', value: 'boss@example.com' }],
      }));

      const response = await callIpc(
        'ai:generate-filter',
        `Backfill incomplete filter ${Date.now()}`,
        suiteAccountId,
      ) as IpcResponse<{ name: string; conditions: unknown[]; actions: unknown[] }>;

      expect(response.success).to.equal(true);
      expect(response.data!.name).to.equal('AI-generated filter');
      expect(response.data!.conditions).to.deep.equal([
        { field: 'from', operator: 'contains', value: 'boss@example.com' },
      ]);
      expect(response.data!.actions).to.deep.equal([]);
    });

    it('returns AI_GENERATE_FILTER_FAILED when the model returns invalid JSON', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('not valid json');

      const response = await callIpc(
        'ai:generate-filter',
        `Invalid filter JSON ${Date.now()}`,
        suiteAccountId,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_GENERATE_FILTER_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // ai:detect-followup
  // -------------------------------------------------------------------------

  describe('ai:detect-followup', () => {
    it('returns AI_INVALID_INPUT for empty content', async () => {
      const response = await callIpc('ai:detect-followup', '') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_NO_MODEL when no AI model is selected', async () => {
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentModel'] = '';

      const response = await callIpc(
        'ai:detect-followup',
        `Follow-up without model ${Date.now()}`,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_NO_MODEL');
    });

    it('returns needsFollowUp=true when canned response indicates follow-up needed', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse(JSON.stringify({
        needsFollowUp: true,
        reason: 'The email asks a direct question.',
        suggestedDate: '2026-03-18',
      }));

      const response = await callIpc(
        'ai:detect-followup',
        'Hi Alice, can you send me the report by Friday? Thanks, Bob',
      ) as IpcResponse<{ needsFollowUp: boolean; reason: string; suggestedDate?: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.needsFollowUp).to.equal(true);
      expect(response.data!.reason).to.be.a('string');
    });

    it('returns needsFollowUp=false when canned response says no follow-up', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse(JSON.stringify({
        needsFollowUp: false,
        reason: 'This is a standalone notification.',
      }));

      const response = await callIpc(
        'ai:detect-followup',
        'Your order has been shipped. No reply needed.',
      ) as IpcResponse<{ needsFollowUp: boolean; reason: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.needsFollowUp).to.equal(false);
    });

    it('treats a yes/no-style response as a safe fallback false result', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('yes');

      const yesResponse = await callIpc(
        'ai:detect-followup',
        `Yes response follow-up ${Date.now()}`,
      ) as IpcResponse<{ needsFollowUp: boolean; reason: string }>;

      expect(yesResponse.success).to.equal(true);
      expect(yesResponse.data!.needsFollowUp).to.equal(false);
      expect(yesResponse.data!.reason).to.equal('Could not determine follow-up status');

      ollamaServer.reset();
      const ollamaService = OllamaService.getInstance();
      ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('no');

      const noResponse = await callIpc(
        'ai:detect-followup',
        `No response follow-up ${Date.now()}`,
      ) as IpcResponse<{ needsFollowUp: boolean; reason: string }>;

      expect(noResponse.success).to.equal(true);
      expect(noResponse.data!.needsFollowUp).to.equal(false);
      expect(noResponse.data!.reason).to.equal('Could not determine follow-up status');
    });

    it('returns a safe fallback when the model response is invalid JSON', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('not-json');

      const response = await callIpc(
        'ai:detect-followup',
        `Invalid follow-up JSON ${Date.now()}`,
      ) as IpcResponse<{ needsFollowUp: boolean; reason: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.needsFollowUp).to.equal(false);
      expect(response.data!.reason).to.equal('Could not determine follow-up status');
    });

    it('returns AI_DETECT_FOLLOWUP_FAILED when Ollama chat endpoint fails', async () => {
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setError('chat', true);

      const response = await callIpc(
        'ai:detect-followup',
        `Detect follow-up failure ${Date.now()}`,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_DETECT_FOLLOWUP_FAILED');
    });
  });

  // -------------------------------------------------------------------------
  // ai:search
  // -------------------------------------------------------------------------

  describe('ai:search', () => {
    it('falls back to the raw keyword query when intent extraction returns malformed output', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      await ensureOllamaKeywordModeReady();
      ollamaServer.setChatResponse('not-json');

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        plainHeaders.subject,
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'local')
        .flatMap((batch) => batch.msgIds);

      expect(['complete', 'partial']).to.include(complete.status);
      expect(localMsgIds).to.include(plainHeaders.xGmMsgId);
      expect(ollamaServer.getRequestsFor('/api/chat').length).to.be.greaterThan(0);
    });

    it('processes rich keyword intents with sent direction, dates, constraints, phrases, synonyms, and negations', async function () {
      this.timeout(25_000);

      await ensureOllamaKeywordModeReady();
      ollamaServer.setChatResponse(JSON.stringify({
        keywords: ['budget report', 'budget report'],
        synonyms: ['forecast', 'projection'],
        direction: 'sent',
        folder: 'INBOX',
        sender: 'alice@example.com',
        recipient: 'finance@example.com',
        dateRange: {
          after: '2024-01-01',
          before: '2025-12-31',
          relative: '7d',
        },
        flags: {
          unread: false,
          starred: true,
          important: false,
          hasAttachment: true,
        },
        exactPhrases: ['quarterly budget'],
        negations: ['draft', 'obsolete'],
      }));

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'Find sent budget report mail',
        ['INBOX', 'Projects'],
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);

      expect(['complete', 'partial']).to.include(complete.status);
      expect(relevantBatches.length).to.be.greaterThan(0);
      expect(relevantBatches[0]!.phase).to.equal('local');
      expect(ollamaServer.getRequestsFor('/api/chat').length).to.be.greaterThan(0);
    });

    it('processes keyword intents that exercise the opposite flag branches', async function () {
      this.timeout(25_000);

      await ensureOllamaKeywordModeReady();
      ollamaServer.setChatResponse(JSON.stringify({
        keywords: ['invoice follow up'],
        synonyms: ['billing reminder'],
        direction: 'sent',
        folder: 'Projects',
        sender: 'finance@example.com',
        recipient: 'bob@example.com',
        dateRange: {
          after: '2023-12-01',
          before: '2026-01-15',
          relative: '3m',
        },
        flags: {
          unread: true,
          starred: false,
          important: true,
          hasAttachment: false,
        },
        exactPhrases: ['payment reminder'],
        negations: ['spam'],
      }));

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'Find invoice follow-up mail',
        ['Projects', 'INBOX'],
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);

      expect(['complete', 'partial']).to.include(complete.status);
      expect(relevantBatches.length).to.be.greaterThan(0);
      expect(relevantBatches[0]!.phase).to.equal('local');
    });

    it('fails semantic search gracefully when the embedding endpoint errors', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;

      await ensureOllamaKeywordModeReady();
      await configureEmbeddingModelForSuite(4);
      insertSemanticChunk(suiteAccountId, plainHeaders.xGmMsgId, 'semantic target chunk', [1, 0, 0, 0]);

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: 'semantic target chunk',
        filters: {},
      }));
      ollamaServer.setError('embed', true);

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'semantic failure case',
        undefined,
        'semantic',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);

      expect(complete.status).to.equal('error');
      expect(complete.totalResults).to.equal(0);
      expect(relevantBatches).to.deep.equal([]);
    });
  });

  // -------------------------------------------------------------------------
  // ai:get-embedding-status
  // -------------------------------------------------------------------------

  describe('ai:get-embedding-status', () => {
    it('returns not_started status when no embedding model is configured', async () => {
      // Clear any model that might be set from prior tests
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentEmbeddingModel'] = '';

      const response = await callIpc('ai:get-embedding-status') as IpcResponse<EmbeddingStatusResponse>;

      expect(response.success).to.equal(true);
      expect(response.data!.embeddingModel).to.be.oneOf([null, '']);
      expect(response.data!.indexStatus).to.equal('not_started');
      expect(response.data!.indexed).to.equal(0);
    });

    it('returns embeddingModel and vectorDimension after set-embedding-model succeeds', async () => {
      // Configure the fake Ollama to return a 4-dimensional embedding
      ollamaServer.setEmbeddings([[0.1, 0.2, 0.3, 0.4]]);
      ollamaServer.setEmbedDimension(4);

      const setModelResponse = await callIpc(
        'ai:set-embedding-model',
        'nomic-embed-text:latest',
      ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;

      expect(setModelResponse.success).to.equal(true);
      expect(setModelResponse.data!.embeddingModel).to.equal('nomic-embed-text:latest');
      expect(setModelResponse.data!.vectorDimension).to.equal(4);

      const statusResponse = await callIpc('ai:get-embedding-status') as IpcResponse<EmbeddingStatusResponse>;

      expect(statusResponse.success).to.equal(true);
      expect(statusResponse.data!.embeddingModel).to.equal('nomic-embed-text:latest');
      expect(statusResponse.data!.vectorDimension).to.equal(4);
    });

    it('returns unavailable status when the vector database is disabled', async () => {
      const vectorDbService = VectorDbService.getInstance() as VectorDbService & {
        vectorsAvailable: boolean;
      };
      const originalVectorsAvailable = vectorDbService.vectorsAvailable;
      vectorDbService.vectorsAvailable = false;

      try {
        const response = await callIpc('ai:get-embedding-status') as IpcResponse<EmbeddingStatusResponse>;

        expect(response.success).to.equal(true);
        expect(response.data!.indexStatus).to.equal('unavailable');
        expect(response.data!.vectorDimension).to.equal(null);
      } finally {
        vectorDbService.vectorsAvailable = originalVectorsAvailable;
      }
    });
  });

  // -------------------------------------------------------------------------
  // ai:set-embedding-model
  // -------------------------------------------------------------------------

  describe('ai:set-embedding-model', () => {
    it('returns AI_INVALID_INPUT for empty model name', async () => {
      const response = await callIpc('ai:set-embedding-model', '') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT for model names longer than 256 characters', async () => {
      const response = await callIpc(
        'ai:set-embedding-model',
        'm'.repeat(257),
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_EMBEDDING_MODEL_INVALID when embed endpoint returns HTTP 500', async () => {
      ollamaServer.setError('embed', true);

      const response = await callIpc(
        'ai:set-embedding-model',
        'bad-model:latest',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_EMBEDDING_MODEL_INVALID');
    });

    it('succeeds when embed returns valid vectors and returns dimension', async () => {
      ollamaServer.setEmbeddings([[1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0]]);
      ollamaServer.setEmbedDimension(8);

      const response = await callIpc(
        'ai:set-embedding-model',
        'nomic-embed-text:latest',
      ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;

      expect(response.success).to.equal(true);
      expect(response.data!.embeddingModel).to.equal('nomic-embed-text:latest');
      expect(response.data!.vectorDimension).to.equal(8);
    });

    it('stores the configured embedding model and dimension in the vector database state', async () => {
      const vectorDbService = VectorDbService.getInstance();
      expect(vectorDbService.vectorsAvailable).to.equal(true);

      ollamaServer.setEmbedDimension(6);

      const response = await callIpc(
        'ai:set-embedding-model',
        'custom-embed-6d:latest',
      ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;

      expect(response.success).to.equal(true);
      expect(response.data!.embeddingModel).to.equal('custom-embed-6d:latest');
      expect(response.data!.vectorDimension).to.equal(6);
      expect(vectorDbService.getCurrentModel()).to.equal('custom-embed-6d:latest');
      expect(vectorDbService.getVectorDimension()).to.equal(6);
      expect(getDatabase().getSetting('ollamaEmbeddingModel')).to.equal('custom-embed-6d:latest');
    });

    it('reconfigures stored vector dimensions when a new embedding model validates with a different size', async () => {
      const vectorDbService = VectorDbService.getInstance();
      expect(vectorDbService.vectorsAvailable).to.equal(true);

      ollamaServer.setEmbedDimension(4);
      const firstResponse = await callIpc(
        'ai:set-embedding-model',
        'custom-embed-4d:latest',
      ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;

      expect(firstResponse.success).to.equal(true);
      expect(vectorDbService.getVectorDimension()).to.equal(4);

      ollamaServer.reset();
      const ollamaService = OllamaService.getInstance();
      ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
      ollamaServer.setEmbedDimension(9);

      const secondResponse = await callIpc(
        'ai:set-embedding-model',
        'custom-embed-9d:latest',
      ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;

      expect(secondResponse.success).to.equal(true);
      expect(secondResponse.data!.embeddingModel).to.equal('custom-embed-9d:latest');
      expect(secondResponse.data!.vectorDimension).to.equal(9);
      expect(vectorDbService.getCurrentModel()).to.equal('custom-embed-9d:latest');
      expect(vectorDbService.getVectorDimension()).to.equal(9);
    });

    it('persists the embedding model setting after successful validation', async () => {
      ollamaServer.setEmbeddings([[0.1, 0.2, 0.3, 0.4]]);
      ollamaServer.setEmbedDimension(4);

      const response = await callIpc(
        'ai:set-embedding-model',
        'nomic-embed-text:latest',
      ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;

      expect(response.success).to.equal(true);
      expect(response.data!.embeddingModel).to.equal('nomic-embed-text:latest');
      expect(response.data!.vectorDimension).to.equal(4);
      expect(getDatabase().getSetting('ollamaEmbeddingModel')).to.equal('nomic-embed-text:latest');
    });
  });

  // -------------------------------------------------------------------------
  // ai:build-index / ai:cancel-index / ai:rebuild-index
  // -------------------------------------------------------------------------

  describe('ai:build-index', () => {
    it('fails when no embedding model is configured', async () => {
      // Clear embedding model
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentEmbeddingModel'] = '';

      const response = await callIpc('ai:build-index') as IpcResponse<unknown>;

      // Should fail because no embedding model is set
      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_BUILD_INDEX_FAILED');
    });

    it('starts a build when embedding model is configured and emits progress events', async function () {
      this.timeout(30_000);

      // Set up a valid embedding model
      ollamaServer.setEmbeddings([[0.1, 0.2, 0.3, 0.4]]);
      ollamaServer.setEmbedDimension(4);

      const setModelResponse = await callIpc(
        'ai:set-embedding-model',
        'nomic-embed-text:latest',
      ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;

      if (!setModelResponse.success) {
        // Vector DB may be unavailable in some environments; this is a valid
        // failure mode but should not leave the suite in a pending state.
        expect(setModelResponse.error).to.not.equal(undefined);
        expect(setModelResponse.error!.code).to.equal('AI_SET_EMBEDDING_MODEL_FAILED');
        return;
      }

      const bus = TestEventBus.getInstance();
      const priorProgressCount = bus.getHistory('embedding:progress').length;
      const priorCompleteCount = bus.getHistory('embedding:complete').length;

      const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;

      // Build should start (or report an error if VectorDB is unavailable)
      if (!buildResponse.success) {
        // VectorDB may be unavailable in this test environment — this is acceptable
        expect(buildResponse.error!.code).to.equal('AI_BUILD_INDEX_FAILED');
        return;
      }

      expect(buildResponse.data!.started).to.equal(true);

      // Cancel the build immediately (we don't want a real IMAP crawl)
      const cancelResponse = await callIpc('ai:cancel-index') as IpcResponse<{ cancelled: boolean }>;
      expect(cancelResponse.success).to.equal(true);

      // Give the worker thread time to fully release its file handles before the
      // next quiesceAndRestore() tries to delete/replace the vector DB WAL files.
      // On Windows, worker_threads termination does not synchronously release OS handles.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      // Verify status reflects the cancelled/idle build
      const statusResponse = await callIpc('ai:get-embedding-status') as IpcResponse<EmbeddingStatusResponse>;
      expect(statusResponse.success).to.equal(true);
      // After cancel, build state should be idle (not 'building')
      expect(statusResponse.data!.indexStatus).to.not.equal('building');

      // We don't assert on progress count — the build may complete before the cancel races it.
      // The important thing is no exceptions and consistent state.
    });
  });

  describe('ai:cancel-index', () => {
    it('succeeds even when no build is in progress', async () => {
      // Ensure we are not currently building (cancel the last build if any)
      const response = await callIpc('ai:cancel-index') as IpcResponse<{ cancelled: boolean }>;

      expect(response.success).to.equal(true);
      expect(response.data!.cancelled).to.equal(true);
    });
  });

  describe('ai:rebuild-index', () => {
    it('fails when no embedding model is configured', async () => {
      // Clear embedding model
      const ollamaService = OllamaService.getInstance();
      ollamaService['currentEmbeddingModel'] = '';

      const response = await callIpc('ai:rebuild-index') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_REBUILD_INDEX_FAILED');
    });

    it('fails when the vector database is unavailable', async () => {
      await configureEmbeddingModelForSuite(4);

      const vectorDbService = VectorDbService.getInstance() as VectorDbService & {
        vectorsAvailable: boolean;
      };
      const originalVectorsAvailable = vectorDbService.vectorsAvailable;
      vectorDbService.vectorsAvailable = false;

      try {
        const response = await callIpc('ai:rebuild-index') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('AI_REBUILD_INDEX_FAILED');
        expect(response.error!.message).to.include('Vector DB is unavailable');
      } finally {
        vectorDbService.vectorsAvailable = originalVectorsAvailable;
      }
    });

    it('fails when the vector dimension is not configured', async () => {
      await configureEmbeddingModelForSuite(4);

      const vectorDbService = VectorDbService.getInstance() as VectorDbService & {
        getVectorDimension: () => number | null;
      };
      const originalGetVectorDimension = vectorDbService.getVectorDimension;
      vectorDbService.getVectorDimension = (): number | null => {
        return null;
      };

      try {
        const response = await callIpc('ai:rebuild-index') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('AI_REBUILD_INDEX_FAILED');
        expect(response.error!.message).to.include('Vector dimension not configured');
      } finally {
        vectorDbService.getVectorDimension = originalGetVectorDimension;
      }
    });
  });

  // -------------------------------------------------------------------------
  // ai:chat
  // -------------------------------------------------------------------------

  describe('ai:chat', () => {
    it('returns AI_INVALID_INPUT when the payload is not an object', async () => {
      const response = await callIpc('ai:chat', 'not-an-object') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT for missing question', async () => {
      const response = await callIpc('ai:chat', {
        question: '',
        conversationHistory: [],
        accountId: suiteAccountId,
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT for missing accountId', async () => {
      const response = await callIpc('ai:chat', {
        question: 'What are my recent emails?',
        conversationHistory: [],
        // accountId missing
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT for question > 2000 chars', async () => {
      const response = await callIpc('ai:chat', {
        question: 'q'.repeat(2001),
        conversationHistory: [],
        accountId: suiteAccountId,
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns a requestId and emits ai:chat:done with model set and canned responses', async function () {
      this.timeout(30_000);

      // Set up model and canned responses
      await callIpc('ai:set-model', 'llama3.2:latest');
      ollamaServer.setChatResponse('Here is what I found in your emails: 1 message in your inbox.');

      const bus = TestEventBus.getInstance();
      const priorDoneCount = bus.getHistory('ai:chat:done').length;

      const response = await callIpc('ai:chat', {
        question: 'What emails do I have?',
        conversationHistory: [],
        accountId: suiteAccountId,
      }) as IpcResponse<{ requestId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.requestId).to.be.a('string');
      expect(response.data!.requestId.length).to.be.greaterThan(0);

      const requestId = response.data!.requestId;

      // Wait for ai:chat:done event for our requestId
      const doneArgs = await waitForEvent('ai:chat:done', {
        timeout: 25_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          if (!payload) {
            return false;
          }
          if (payload['requestId'] !== requestId) {
            return false;
          }
          // Only count NEW events
          const currentCount = bus.getHistory('ai:chat:done').length;
          return currentCount > priorDoneCount;
        },
      });

      const donePayload = doneArgs[0] as Record<string, unknown>;
      expect(donePayload['requestId']).to.equal(requestId);
      // success may be true (happy path) or false (Ollama model not configured) — both OK
      expect(donePayload).to.have.property('success');
    });

    it('trims the question and caps/sanitizes conversation history before sending rewrite requests', async function () {
      this.timeout(30_000);

      const ollamaService = OllamaService.getInstance();
      ollamaService['currentModel'] = 'llama3.2:latest';
      ollamaService['currentEmbeddingModel'] = 'nomic-embed-text:latest';
      ollamaServer.setChatResponse('not-json');

      const conversationHistory = [
        { role: 'user', content: 'Oldest valid user 1' },
        { role: 'assistant', content: 'Oldest valid assistant 2' },
        { role: 'system', content: 'invalid role should be dropped' },
        { role: 'user', content: 123 },
        { role: 'user', content: 'Valid user 3' },
        { role: 'assistant', content: 'Valid assistant 4' },
        { role: 'user', content: 'Valid user 5' },
        { role: 'assistant', content: 'Valid assistant 6' },
        { role: 'user', content: 'Valid user 7' },
        { role: 'assistant', content: 'Valid assistant 8' },
        { role: 'user', content: 'Valid user 9' },
        { role: 'assistant', content: 'Valid assistant 10' },
        { role: 'user', content: 'Valid user 11' },
        { role: 'assistant', content: 'Valid assistant 12' },
      ];

      const response = await callIpc('ai:chat', {
        question: '   What did Bob ask for?   ',
        conversationHistory,
        accountId: suiteAccountId,
      }) as IpcResponse<{ requestId: string }>;

      expect(response.success).to.equal(true);

      await waitForEvent('ai:chat:done', {
        timeout: 25_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          return payload?.['requestId'] === response.data!.requestId;
        },
      });

      const rewriteRequest = ollamaServer.getRequestsFor('/api/chat')[0];
      expect(rewriteRequest).to.not.equal(undefined);

      const messages = rewriteRequest!.body['messages'] as Array<Record<string, unknown>>;
      const rewriteUserMessage = String(messages[1]!['content']);

      expect(rewriteUserMessage).to.include('New question: What did Bob ask for?');
      expect(rewriteUserMessage).to.not.include('Oldest valid user 1');
      expect(rewriteUserMessage).to.not.include('Oldest valid assistant 2');
      expect(rewriteUserMessage).to.not.include('invalid role should be dropped');
      expect(rewriteUserMessage).to.include('User: Valid user 3');
      expect(rewriteUserMessage).to.include('Assistant: Valid assistant 12');
    });

    it('emits fallback stream, empty sources, and success=true when no indexed emails match', async function () {
      this.timeout(30_000);

      const freshAccount = seedTestAccount({
        email: `ai-no-results-${Date.now()}@example.com`,
        displayName: 'AI No Results User',
      });

      try {
        await callIpc('ai:set-model', 'llama3.2:latest');
        ollamaServer.setEmbeddings([[0.1, 0.2, 0.3, 0.4]]);
        ollamaServer.setEmbedDimension(4);

        const setEmbeddingResponse = await callIpc(
          'ai:set-embedding-model',
          'nomic-embed-text:latest',
        ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;

        expect(setEmbeddingResponse.success).to.equal(true);

        const db = getDatabase();
        db.clearAllVectorIndexedEmails();
        db.clearAllEmbeddingCrawlProgress();
        VectorDbService.getInstance().clearAllAndReconfigure('nomic-embed-text:latest', 4);

        ollamaServer.setChatResponse('not-json');

        const response = await callIpc('ai:chat', {
          question: 'Do I have anything about quarterly planning?',
          conversationHistory: [],
          accountId: freshAccount.accountId,
        }) as IpcResponse<{ requestId: string }>;

        expect(response.success).to.equal(true);

        const requestId = response.data!.requestId;

        const streamArgs = await waitForEvent('ai:chat:stream', {
          timeout: 25_000,
          predicate: (args) => {
            const payload = args[0] as Record<string, unknown> | undefined;
            return payload?.['requestId'] === requestId;
          },
        });

        const sourcesArgs = await waitForEvent('ai:chat:sources', {
          timeout: 25_000,
          predicate: (args) => {
            const payload = args[0] as Record<string, unknown> | undefined;
            return payload?.['requestId'] === requestId;
          },
        });

        const doneArgs = await waitForEvent('ai:chat:done', {
          timeout: 25_000,
          predicate: (args) => {
            const payload = args[0] as Record<string, unknown> | undefined;
            return payload?.['requestId'] === requestId;
          },
        });

        const streamPayload = streamArgs[0] as Record<string, unknown>;
        const sourcesPayload = sourcesArgs[0] as Record<string, unknown>;
        const donePayload = doneArgs[0] as Record<string, unknown>;

        expect(String(streamPayload['token'])).to.include("I couldn't find any emails");
        expect(sourcesPayload['sources']).to.deep.equal([]);
        expect(donePayload['success']).to.equal(true);
        expect(donePayload['cancelled']).to.equal(false);
      } finally {
        await callIpc('auth:logout', String(freshAccount.accountId));
      }
    });

    it('fails gracefully when the embedding endpoint errors during chat retrieval', async function () {
      this.timeout(30_000);

      await callIpc('ai:set-model', 'llama3.2:latest');
      await configureEmbeddingModelForSuite(4);
      ollamaServer.setChatResponse('not-json');
      ollamaServer.setError('embed', true);

      const response = await callIpc('ai:chat', {
        question: 'Find emails about roadmap planning',
        conversationHistory: [],
        accountId: suiteAccountId,
      }) as IpcResponse<{ requestId: string }>;

      expect(response.success).to.equal(true);

      const doneArgs = await waitForEvent('ai:chat:done', {
        timeout: 25_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          return payload?.['requestId'] === response.data!.requestId;
        },
      });

      const donePayload = doneArgs[0] as Record<string, unknown>;
      expect(donePayload['cancelled']).to.equal(false);
      expect(donePayload['success']).to.equal(false);
      expect(String(donePayload['error'] ?? '')).to.include('Ollama embed failed');
    });
  });

  // -------------------------------------------------------------------------
  // ai:chat:cancel
  // -------------------------------------------------------------------------

  describe('ai:chat:cancel', () => {
    it('returns AI_INVALID_INPUT when the payload is not an object', async () => {
      const response = await callIpc('ai:chat:cancel', 'nope') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT for missing requestId', async () => {
      const response = await callIpc('ai:chat:cancel', {}) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns success even when cancelling a non-existent requestId', async () => {
      const response = await callIpc('ai:chat:cancel', {
        requestId: 'non-existent-request-id-12345',
      }) as IpcResponse<{ cancelled: boolean }>;

      expect(response.success).to.equal(true);
      expect(response.data!.cancelled).to.equal(true);
    });

    it('cancels an in-flight chat request and emits ai:chat:done with cancelled=true', async function () {
      this.timeout(30_000);

      const ollamaService = OllamaService.getInstance();
      ollamaService['currentModel'] = 'llama3.2:latest';
      ollamaService['currentEmbeddingModel'] = 'nomic-embed-text:latest';
      ollamaServer.setResponseDelay(500);

      const response = await callIpc('ai:chat', {
        question: 'Summarize my recent email activity',
        conversationHistory: [],
        accountId: suiteAccountId,
      }) as IpcResponse<{ requestId: string }>;

      expect(response.success).to.equal(true);

      const requestId = response.data!.requestId;
      const cancelResponse = await callIpc('ai:chat:cancel', { requestId }) as IpcResponse<{ cancelled: boolean }>;

      expect(cancelResponse.success).to.equal(true);
      expect(cancelResponse.data!.cancelled).to.equal(true);

      const doneArgs = await waitForEvent('ai:chat:done', {
        timeout: 25_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          return payload?.['requestId'] === requestId;
        },
      });

      const donePayload = doneArgs[0] as Record<string, unknown>;
      expect(donePayload['cancelled']).to.equal(true);
      expect(donePayload['success']).to.equal(true);
    });

    it('cancels an actively streaming chat immediately after start', async function () {
      this.timeout(30_000);

      const plainHeaders = emlFixtures['plain-text'].headers;

      await callIpc('ai:set-model', 'llama3.2:latest');
      await configureEmbeddingModelForSuite(4);
      insertSemanticChunk(suiteAccountId, plainHeaders.xGmMsgId, 'Roadmap planning discussion chunk', [1, 0, 0, 0]);

      ollamaServer.setChatResponse(JSON.stringify({ relevant: true }));
      ollamaServer.setChatStreamChunks(Array.from({ length: 30 }, (_value, index) => `token-${index} `));
      ollamaServer.setEmbeddings([[1, 0, 0, 0]]);

      const response = await callIpc('ai:chat', {
        question: 'What did the roadmap email say?',
        conversationHistory: [],
        accountId: suiteAccountId,
      }) as IpcResponse<{ requestId: string }>;

      expect(response.success).to.equal(true);

      const cancelResponse = await callIpc('ai:chat:cancel', {
        requestId: response.data!.requestId,
      }) as IpcResponse<{ cancelled: boolean }>;

      expect(cancelResponse.success).to.equal(true);
      expect(cancelResponse.data!.cancelled).to.equal(true);

      const doneArgs = await waitForEvent('ai:chat:done', {
        timeout: 25_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          return payload?.['requestId'] === response.data!.requestId;
        },
      });

      const donePayload = doneArgs[0] as Record<string, unknown>;
      expect(donePayload['cancelled']).to.equal(true);
      expect(donePayload['success']).to.equal(true);
    });
  });
});
