/**
 * search-keyword-semantic.test.ts — Backend E2E tests for keyword and semantic search.
 *
 * Covers:
 *   - ai:search with mode='keyword': returns a searchToken immediately, then emits
 *     ai:search:batch events with local matches and ai:search:complete with status='complete'/'partial'
 *   - ai:search with Ollama disconnected: falls back to keyword search automatically
 *   - ai:search local-first: DB results emitted in 'local' batch before IMAP fallback
 *   - ai:search IMAP fallback: IMAP phase emits results for messages not in local DB
 *   - ai:search with mode='semantic': returns searchToken; emits ai:search:complete
 *   - ai:search validation: empty query → AI_INVALID_INPUT
 *   - ai:search validation: invalid accountId → AI_INVALID_INPUT
 *   - ai:search validation: query > 2048 chars → AI_INVALID_INPUT
 *   - mail:search-by-msgids: resolves known xGmMsgIds to thread rows
 *   - ai:chat:navigate: resolves a known xGmMsgId and emits ai:search:batch + ai:search:complete
 *
 * Pattern:
 *   - before(): quiesce/restore + seed one account + inject messages into IMAP + run sync
 *   - Use callIpc to trigger search and waitForEvent to receive streaming events
 */

import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  getDatabase,
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

// ---- Suite-level state ----

let suiteAccountId: number;
let suiteEmail: string;

// ---- Helper: wait for ai:search:complete for a specific searchToken ----

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

// ---- Helper: collect all ai:search:batch events for a searchToken ----
// Waits until ai:search:complete arrives, then returns accumulated batch results.

async function collectSearchBatches(
  searchToken: string,
  timeoutMs: number = 20_000,
): Promise<{ batches: SearchBatchPayload[]; complete: SearchCompletePayload }> {
  const bus = TestEventBus.getInstance();
  const priorBatchCount = bus.getHistory('ai:search:batch').length;

  // Wait for complete first (it arrives after all batches)
  const complete = await waitForSearchComplete(searchToken, timeoutMs);

  // Gather any batch events that arrived for our token
  const allBatchEvents = bus.getHistory('ai:search:batch');
  const batches = allBatchEvents
    .slice(priorBatchCount)
    .map((record) => record.args[0] as SearchBatchPayload)
    .filter((payload) => payload != null && payload.searchToken === searchToken);

  return { batches, complete };
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

async function prepareSemanticPipeline(queryEmbedding: number[] = [1, 0, 0, 0]): Promise<void> {
  const vectorDbService = VectorDbService.getInstance();
  expect(vectorDbService.vectorsAvailable).to.equal(true);

  ollamaServer.setError('health', false);
  ollamaServer.setEmbeddings([queryEmbedding]);
  ollamaServer.setEmbedDimension(queryEmbedding.length);

  const statusResponse = await callIpc('ai:get-status') as IpcResponse<{ connected: boolean }>;
  expect(statusResponse.success).to.equal(true);
  expect(statusResponse.data!.connected).to.equal(true);

  const setModelResponse = await callIpc(
    'ai:set-model',
    'llama3.2:latest',
  ) as IpcResponse<{ currentModel: string }>;
  expect(setModelResponse.success).to.equal(true);
  expect(setModelResponse.data!.currentModel).to.equal('llama3.2:latest');

  const setEmbeddingResponse = await callIpc(
    'ai:set-embedding-model',
    'nomic-embed-text:latest',
  ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;
  expect(setEmbeddingResponse.success).to.equal(true);
  expect(setEmbeddingResponse.data!.embeddingModel).to.equal('nomic-embed-text:latest');
  expect(setEmbeddingResponse.data!.vectorDimension).to.equal(queryEmbedding.length);
  expect(vectorDbService.getVectorDimension()).to.equal(queryEmbedding.length);
}

// =========================================================================
// Keyword and Semantic Search
// =========================================================================

describe('Search (Keyword and Semantic)', () => {
  before(async function () {
    this.timeout(40_000);

    await quiesceAndRestore();

    const seeded = seedTestAccount({
      email: 'search-test@example.com',
      displayName: 'Search Test User',
    });
    suiteAccountId = seeded.accountId;
    suiteEmail = seeded.email;

    // Reset IMAP state and configure for this account
    imapStateInspector.reset();
    imapStateInspector.getServer().addAllowedAccount(suiteEmail);

    // Reset Ollama fake to defaults (disconnected)
    ollamaServer.reset();

    // Inject messages into INBOX and All Mail so they are indexed after sync
    const plainMsg = emlFixtures['plain-text'];
    const htmlMsg = emlFixtures['html-email'];
    const thread1 = emlFixtures['reply-thread-1'];
    const thread2 = emlFixtures['reply-thread-2'];
    const thread3 = emlFixtures['reply-thread-3'];

    // INBOX
    imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
      xGmMsgId: plainMsg.headers.xGmMsgId,
      xGmThrid: plainMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
    imapStateInspector.injectMessage('INBOX', htmlMsg.raw, {
      xGmMsgId: htmlMsg.headers.xGmMsgId,
      xGmThrid: htmlMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
    imapStateInspector.injectMessage('INBOX', thread1.raw, {
      xGmMsgId: thread1.headers.xGmMsgId,
      xGmThrid: thread1.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
    imapStateInspector.injectMessage('INBOX', thread2.raw, {
      xGmMsgId: thread2.headers.xGmMsgId,
      xGmThrid: thread2.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
    imapStateInspector.injectMessage('INBOX', thread3.raw, {
      xGmMsgId: thread3.headers.xGmMsgId,
      xGmThrid: thread3.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });

    // [Gmail]/All Mail (required for sync to populate threads table)
    imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
      xGmMsgId: plainMsg.headers.xGmMsgId,
      xGmThrid: plainMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', htmlMsg.raw, {
      xGmMsgId: htmlMsg.headers.xGmMsgId,
      xGmThrid: htmlMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', thread1.raw, {
      xGmMsgId: thread1.headers.xGmMsgId,
      xGmThrid: thread1.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', thread2.raw, {
      xGmMsgId: thread2.headers.xGmMsgId,
      xGmThrid: thread2.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', thread3.raw, {
      xGmMsgId: thread3.headers.xGmMsgId,
      xGmThrid: thread3.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });

    // Run sync so messages appear in the local DB
    await triggerSyncAndWait(suiteAccountId, { timeout: 30_000 });
  });

  afterEach(() => {
    ollamaServer.reset();

    const ollamaService = OllamaService.getInstance();
    ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
    ollamaService.setModel('');
    ollamaService.setEmbeddingModel('');

    try {
      VectorDbService.getInstance().deleteByAccountId(suiteAccountId);
    } catch {
      // Vector DB may be unavailable in some test environments.
    }
  });

  // -------------------------------------------------------------------------
  // Input validation
  // -------------------------------------------------------------------------

  describe('ai:search — validation', () => {
    it('returns AI_INVALID_INPUT for an empty query', async () => {
      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        '',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT for an invalid accountId', async () => {
      const response = await callIpc(
        'ai:search',
        'not-a-number',
        'some query',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT when query exceeds 2048 characters', async () => {
      const longQuery = 'a'.repeat(2049);

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        longQuery,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });
  });

  // -------------------------------------------------------------------------
  // Keyword search — Ollama not connected, falls back automatically
  // -------------------------------------------------------------------------

  describe('ai:search — keyword mode (Ollama disconnected)', () => {
    it('returns a searchToken immediately and emits ai:search:complete', async function () {
      this.timeout(25_000);

      // Ensure Ollama is NOT connected for this test
      ollamaServer.setError('health', true);

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'test email subject',
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.searchToken).to.be.a('string');
      expect(response.data!.searchToken.length).to.be.greaterThan(0);

      const searchToken = response.data!.searchToken;

      // Wait for the complete event
      const complete = await waitForSearchComplete(searchToken);
      expect(complete.searchToken).to.equal(searchToken);
      expect(['complete', 'partial']).to.include(complete.status);

      // Restore server
      ollamaServer.setError('health', false);
    });

    it('emits ai:search:batch events with local-phase results when messages match', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const eventBus = TestEventBus.getInstance();
      const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        plainHeaders.subject,
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      // Collect all batch events and wait for complete
      const { complete } = await collectSearchBatches(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'local')
        .flatMap((batch) => batch.msgIds);

      expect(complete.searchToken).to.equal(searchToken);
      expect(['complete', 'partial']).to.include(complete.status);
      expect(localMsgIds).to.include(plainHeaders.xGmMsgId);
    });

    it('includes known xGmMsgId in local batch when messages are indexed', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      // Search using the full subject — should hit local DB first
      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        plainHeaders.subject,
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      // Wait for complete
      const complete = await waitForSearchComplete(searchToken);
      expect(['complete', 'partial']).to.include(complete.status);

      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'local')
        .flatMap((batch) => batch.msgIds);

      expect(localMsgIds).to.include(plainHeaders.xGmMsgId);
    });
  });

  // -------------------------------------------------------------------------
  // Keyword search — explicit keyword mode
  // -------------------------------------------------------------------------

  describe('ai:search — explicit keyword mode', () => {
    it('returns searchToken and completes even for a query with no matches', async function () {
      this.timeout(20_000);

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'zzznomatchxxx99999',
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      const complete = await waitForSearchComplete(searchToken);
      expect(complete.searchToken).to.equal(searchToken);
      expect(['complete', 'partial']).to.include(complete.status);
      expect(complete.totalResults).to.equal(0);
    });

    it('returns batch events with phase=local before phase=imap', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const eventBus = TestEventBus.getInstance();
      const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        plainHeaders.subject,
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      await waitForSearchComplete(searchToken);

      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const phases = relevantBatches.map((batch) => batch.phase);

      expect(phases.length).to.be.greaterThan(1);
      expect(phases[0]).to.equal('local');
      expect(phases).to.include('imap');
      expect(phases.lastIndexOf('local')).to.be.lessThan(phases.indexOf('imap'));
    });

    it('emits an imap batch for results that only exist on the server', async function () {
      this.timeout(25_000);

      const serverOnlyMsgId = '1000000000000099';
      const serverOnlyThreadId = '2000000000000099';
      const uniqueSubject = 'Quarterly forecast server only 98231';
      const serverOnlyRaw = Buffer.from(
        [
          'From: server-only@example.com',
          `To: ${suiteEmail}`,
          `Subject: ${uniqueSubject}`,
          'Date: Sat, 06 Jan 2024 12:00:00 +0000',
          'Message-ID: <server-only-001@example.com>',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: 7bit',
          `X-GM-MSGID: ${serverOnlyMsgId}`,
          `X-GM-THRID: ${serverOnlyThreadId}`,
          'X-GM-LABELS: \\All Mail',
          '',
          'This message only exists on IMAP until the keyword search fetches it.',
        ].join('\n'),
        'utf8',
      );

      imapStateInspector.injectMessage('[Gmail]/All Mail', serverOnlyRaw, {
        xGmMsgId: serverOnlyMsgId,
        xGmThrid: serverOnlyThreadId,
        xGmLabels: ['\\All Mail'],
      });

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'forecast 98231',
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localBatches = relevantBatches.filter((batch) => batch.phase === 'local');
      const imapMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'imap')
        .flatMap((batch) => batch.msgIds);

      expect(localBatches.length).to.be.greaterThan(0);
      expect(localBatches[0]!.msgIds).to.deep.equal([]);
      expect(imapMsgIds).to.include(serverOnlyMsgId);
      expect(complete.status).to.equal('complete');
      expect(complete.totalResults).to.equal(1);
    });
  });

  // -------------------------------------------------------------------------
  // mail:search-by-msgids — xGmMsgId search
  // -------------------------------------------------------------------------

  describe('mail:search-by-msgids — resolves xGmMsgIds to thread rows', () => {
    it('returns thread rows for known xGmMsgIds', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;
      const htmlHeaders = emlFixtures['html-email'].headers;

      const response = await callIpc(
        'mail:search-by-msgids',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId, htmlHeaders.xGmMsgId],
      ) as IpcResponse<Array<Record<string, unknown>>>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');
      expect(response.data!.length).to.equal(2);

      const returnedThreadIds = response.data!.map((thread) => thread['xGmThrid']);
      expect(returnedThreadIds).to.deep.equal([
        plainHeaders.xGmThrid,
        htmlHeaders.xGmThrid,
      ]);

      // Each result should have the required thread fields
      for (const thread of response.data!) {
        expect(thread).to.have.property('xGmThrid');
        expect(thread).to.have.property('labels').that.is.an('array');
      }
    });

    it('returns an empty array for unknown xGmMsgIds', async () => {
      const response = await callIpc(
        'mail:search-by-msgids',
        String(suiteAccountId),
        ['nonexistent-msg-id-12345', 'another-fake-id-67890'],
      ) as IpcResponse<Array<Record<string, unknown>>>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');
      expect(response.data!.length).to.equal(0);
    });

    it('returns error for empty array', async () => {
      const response = await callIpc(
        'mail:search-by-msgids',
        String(suiteAccountId),
        [],
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_SEARCH_INVALID_INPUT');
    });

    it('returns error when more than 200 IDs are supplied', async () => {
      const tooManyIds = Array.from({ length: 201 }, (_, index) => `msg-id-${index}`);

      const response = await callIpc(
        'mail:search-by-msgids',
        String(suiteAccountId),
        tooManyIds,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_SEARCH_INVALID_INPUT');
    });

    it('returns error when any supplied ID is not a string', async () => {
      const response = await callIpc(
        'mail:search-by-msgids',
        String(suiteAccountId),
        [emlFixtures['plain-text'].headers.xGmMsgId, 42],
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_SEARCH_INVALID_INPUT');
    });
  });

  // -------------------------------------------------------------------------
  // ai:chat:navigate — MessageId search via streaming
  // -------------------------------------------------------------------------

  describe('ai:chat:navigate — navigate to a source email', () => {
    it('returns a searchToken and emits ai:search:complete for a known xGmMsgId', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const eventBus = TestEventBus.getInstance();
      const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:chat:navigate',
        {
          accountId: suiteAccountId,
          xGmMsgId: plainHeaders.xGmMsgId,
        },
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.searchToken).to.be.a('string');

      const searchToken = response.data!.searchToken;

      // Wait for the search to complete (may or may not find results depending on IMAP availability)
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'local')
        .flatMap((batch) => batch.msgIds);
      const imapMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'imap')
        .flatMap((batch) => batch.msgIds);

      expect(complete.searchToken).to.equal(searchToken);
      expect(complete.status).to.equal('complete');
      expect(complete.totalResults).to.equal(1);
      expect(localMsgIds).to.include(plainHeaders.xGmMsgId);
      expect(imapMsgIds).to.deep.equal([]);
    });

    it('returns AI_INVALID_INPUT when accountId is missing', async () => {
      const response = await callIpc(
        'ai:chat:navigate',
        {
          xGmMsgId: 'some-msg-id',
          // Missing accountId
        },
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('returns AI_INVALID_INPUT when xGmMsgId is missing', async () => {
      const response = await callIpc(
        'ai:chat:navigate',
        {
          accountId: suiteAccountId,
          // Missing xGmMsgId
        },
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('fetches from IMAP when the source email is missing locally but exists on the server', async function () {
      this.timeout(25_000);

      const serverOnlyMsgId = '1000000000000101';
      const serverOnlyThreadId = '2000000000000101';
      const serverOnlyRaw = Buffer.from(
        [
          'From: navigate-imap@example.com',
          `To: ${suiteEmail}`,
          'Subject: Navigate IMAP fallback message',
          'Date: Sun, 07 Jan 2024 12:00:00 +0000',
          'Message-ID: <navigate-imap-fallback-001@example.com>',
          'MIME-Version: 1.0',
          'Content-Type: text/plain; charset=UTF-8',
          'Content-Transfer-Encoding: 7bit',
          `X-GM-MSGID: ${serverOnlyMsgId}`,
          `X-GM-THRID: ${serverOnlyThreadId}`,
          'X-GM-LABELS: \\Inbox \\All Mail',
          '',
          'This source email should be resolved through IMAP fallback.',
        ].join('\n'),
        'utf8',
      );

      imapStateInspector.injectMessage('[Gmail]/All Mail', serverOnlyRaw, {
        xGmMsgId: serverOnlyMsgId,
        xGmThrid: serverOnlyThreadId,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });

      const databaseService = getDatabase();
      expect(databaseService.getEmailByXGmMsgId(suiteAccountId, serverOnlyMsgId)).to.equal(null);

      const eventBus = TestEventBus.getInstance();
      const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:chat:navigate',
        {
          accountId: suiteAccountId,
          xGmMsgId: serverOnlyMsgId,
        },
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localBatches = relevantBatches.filter((batch) => batch.phase === 'local');
      const imapMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'imap')
        .flatMap((batch) => batch.msgIds);

      expect(complete.status).to.equal('complete');
      expect(complete.totalResults).to.equal(1);
      expect(localBatches.length).to.be.greaterThan(0);
      expect(localBatches[0]!.msgIds).to.deep.equal([]);
      expect(imapMsgIds).to.include(serverOnlyMsgId);
      expect(databaseService.getEmailByXGmMsgId(suiteAccountId, serverOnlyMsgId)).to.not.equal(null);

      const resolvedResponse = await callIpc(
        'mail:search-by-msgids',
        String(suiteAccountId),
        [serverOnlyMsgId],
      ) as IpcResponse<Array<Record<string, unknown>>>;

      expect(resolvedResponse.success).to.equal(true);
      expect(resolvedResponse.data).to.have.length(1);
      expect(resolvedResponse.data![0]!['xGmThrid']).to.equal(serverOnlyThreadId);
    });

    it('completes with no results for an unknown xGmMsgId', async function () {
      this.timeout(25_000);

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:chat:navigate',
        {
          accountId: suiteAccountId,
          xGmMsgId: 'missing-msg-id-999999',
        },
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localBatches = relevantBatches.filter((batch) => batch.phase === 'local');
      const imapBatches = relevantBatches.filter((batch) => batch.phase === 'imap');

      expect(complete.status).to.equal('complete');
      expect(complete.totalResults).to.equal(0);
      expect(localBatches.length).to.be.greaterThan(0);
      expect(localBatches[0]!.msgIds).to.deep.equal([]);
      expect(imapBatches.length).to.be.greaterThan(0);
      expect(imapBatches[0]!.msgIds).to.deep.equal([]);
    });
  });

  // -------------------------------------------------------------------------
  // ai:search — semantic mode (when Ollama is connected and configured)
  // -------------------------------------------------------------------------

  describe('ai:search — semantic mode happy path', () => {
    it('emits a local semantic batch when embeddings and vector results are available', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      await prepareSemanticPipeline([1, 0, 0, 0]);
      const priorEmbedCount = ollamaServer.getRequestsFor('/api/embed').length;

      VectorDbService.getInstance().insertChunks({
        accountId: suiteAccountId,
        xGmMsgId: plainHeaders.xGmMsgId,
        chunks: [
          {
            chunkIndex: 0,
            chunkText: 'Plain text semantic search target',
            embedding: [1, 0, 0, 0],
          },
        ],
      });

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'semantic-vector-only-query-77441',
        undefined,
        'semantic',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'local')
        .flatMap((batch) => batch.msgIds);
      const imapMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'imap')
        .flatMap((batch) => batch.msgIds);

      expect(complete.status).to.equal('complete');
      expect(complete.totalResults).to.equal(1);
      expect(localMsgIds).to.include(plainHeaders.xGmMsgId);
      expect(imapMsgIds).to.deep.equal([]);
      expect(ollamaServer.getRequestsFor('/api/embed').length).to.be.greaterThan(priorEmbedCount);
    });

    it('completes with zero results when semantic pipeline is ready but vector search finds nothing', async function () {
      this.timeout(25_000);

      const isolatedAccount = seedTestAccount({
        email: 'search-semantic-empty@example.com',
        displayName: 'Semantic Empty Search User',
      });

      await prepareSemanticPipeline([1, 0, 0, 0]);

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(isolatedAccount.accountId),
        'semantic query with no indexed matches',
        undefined,
        'semantic',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);

      expect(complete.status).to.equal('complete');
      expect(complete.totalResults).to.equal(0);
      expect(relevantBatches).to.deep.equal([]);

      try {
        VectorDbService.getInstance().deleteByAccountId(isolatedAccount.accountId);
      } catch {
        // Vector DB may be unavailable in some test environments.
      }
    });

    it('falls back to filter-only search when semantic intent contains only filters', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const thread1Headers = emlFixtures['reply-thread-1'].headers;
      const thread3Headers = emlFixtures['reply-thread-3'].headers;

      await prepareSemanticPipeline([1, 0, 0, 0]);
      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: '',
        filters: {
          sender: 'alice@example.com',
        },
      }));

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'semantic filter only from alice 2026-03-11',
        undefined,
        'semantic',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);

      const searchToken = response.data!.searchToken;
      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'local')
        .flatMap((batch) => batch.msgIds);
      const imapMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'imap')
        .flatMap((batch) => batch.msgIds);

      expect(complete.status).to.equal('complete');
      expect(localMsgIds).to.include(plainHeaders.xGmMsgId);
      expect(localMsgIds).to.include(thread1Headers.xGmMsgId);
      expect(localMsgIds).to.include(thread3Headers.xGmMsgId);
      expect(localMsgIds).to.not.include(emlFixtures['html-email'].headers.xGmMsgId);
      expect(imapMsgIds).to.deep.equal([]);
    });
  });

  describe('ai:search — semantic mode falls back to keyword when not ready', () => {
    it('automatically falls back from semantic mode and still streams keyword results when Ollama is disconnected', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const eventBus = TestEventBus.getInstance();
      const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

      ollamaServer.setError('health', true);

      const statusResponse = await callIpc('ai:get-status') as IpcResponse<{ connected: boolean }>;
      expect(statusResponse.success).to.equal(true);
      expect(statusResponse.data!.connected).to.equal(false);

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        plainHeaders.subject,
        undefined,
        'semantic',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      const complete = await waitForSearchComplete(searchToken);
      const relevantBatches = getSearchBatchesSince(searchToken, priorBatchCount);
      const localMsgIds = relevantBatches
        .filter((batch) => batch.phase === 'local')
        .flatMap((batch) => batch.msgIds);

      expect(complete.searchToken).to.equal(searchToken);
      expect(['complete', 'partial']).to.include(complete.status);
      expect(localMsgIds).to.include(plainHeaders.xGmMsgId);

      ollamaServer.setError('health', false);
    });

    it('returns searchToken and completes in semantic mode (no embedding model configured)', async function () {
      this.timeout(25_000);

      // Semantic pipeline is NOT ready (no embedding model) — should fall back to keyword
      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        'find my important messages',
        undefined,
        'semantic',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      // Complete event must arrive regardless of mode fallback
      const complete = await waitForSearchComplete(searchToken);
      expect(complete.searchToken).to.equal(searchToken);
      expect(['complete', 'partial']).to.include(complete.status);
    });
  });
});
