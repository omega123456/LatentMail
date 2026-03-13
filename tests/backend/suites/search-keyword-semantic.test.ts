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
import { DateTime } from 'luxon';
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
import { parseGmailQuery } from '../../../electron/utils/gmail-query-parser';

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

interface SeedLocalEmailOptions {
  accountId: number;
  subject: string;
  fromAddress?: string;
  fromName?: string;
  toAddresses?: string;
  textBody?: string;
  htmlBody?: string;
  dateIso?: string;
  folders?: string[];
  isRead?: boolean;
  isStarred?: boolean;
  isImportant?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  labels?: string;
}

interface SearchRunResult {
  searchToken: string;
  complete: SearchCompletePayload;
  batches: SearchBatchPayload[];
  localMsgIds: string[];
  imapMsgIds: string[];
  allMsgIds: string[];
}

let syntheticMessageCounter = 0;

function createSyntheticIdentifiers(): { xGmMsgId: string; xGmThrid: string; messageId: string } {
  syntheticMessageCounter += 1;

  return {
    xGmMsgId: (BigInt('9900000000000000') + BigInt(syntheticMessageCounter)).toString(),
    xGmThrid: (BigInt('9800000000000000') + BigInt(syntheticMessageCounter)).toString(),
    messageId: `<search-synthetic-${syntheticMessageCounter}@example.com>`,
  };
}

function seedLocalEmail(options: SeedLocalEmailOptions): { xGmMsgId: string; xGmThrid: string } {
  const db = getDatabase();
  const identifiers = createSyntheticIdentifiers();
  const folders = options.folders ?? ['INBOX'];
  const primaryFolder = folders[0] ?? 'INBOX';
  const dateIso = options.dateIso ?? DateTime.utc().toISO()!;
  const textBody = options.textBody ?? '';
  const htmlBody = options.htmlBody ?? '';
  const rawDb = db.getDatabase();

  db.upsertThread({
    accountId: options.accountId,
    xGmThrid: identifiers.xGmThrid,
    subject: options.subject,
    lastMessageDate: dateIso,
    participants: options.fromAddress ?? 'local-search@example.com',
    messageCount: 1,
    snippet: textBody || htmlBody,
    isRead: options.isRead ?? false,
    isStarred: options.isStarred ?? false,
  });

  db.upsertEmail({
    accountId: options.accountId,
    xGmMsgId: identifiers.xGmMsgId,
    xGmThrid: identifiers.xGmThrid,
    folder: primaryFolder,
    fromAddress: options.fromAddress ?? 'local-search@example.com',
    fromName: options.fromName ?? options.fromAddress ?? 'local-search@example.com',
    toAddresses: options.toAddresses ?? 'recipient@example.com',
    ccAddresses: '',
    bccAddresses: '',
    subject: options.subject,
    textBody,
    htmlBody,
    date: dateIso,
    isRead: options.isRead ?? false,
    isStarred: options.isStarred ?? false,
    isImportant: options.isImportant ?? false,
    isDraft: options.isDraft ?? false,
    snippet: textBody || htmlBody,
    size: Math.max(textBody.length, htmlBody.length, options.subject.length),
    hasAttachments: options.hasAttachments ?? false,
    labels: options.labels ?? folders.join(','),
    messageId: identifiers.messageId,
  });

  for (const folder of folders.slice(1)) {
    rawDb.prepare(
      `INSERT OR IGNORE INTO email_folders (account_id, x_gm_msgid, folder)
       VALUES (:accountId, :xGmMsgId, :folder)`
    ).run({
      accountId: options.accountId,
      xGmMsgId: identifiers.xGmMsgId,
      folder,
    });
  }

  return {
    xGmMsgId: identifiers.xGmMsgId,
    xGmThrid: identifiers.xGmThrid,
  };
}

function seedLabelForAccount(options: {
  accountId: number;
  gmailLabelId: string;
  name: string;
  type?: string;
  specialUse?: string;
}): void {
  getDatabase().upsertLabel({
    accountId: options.accountId,
    gmailLabelId: options.gmailLabelId,
    name: options.name,
    type: options.type ?? 'user',
    unreadCount: 0,
    totalCount: 0,
    specialUse: options.specialUse,
  });
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

function createServerOnlyRawEmail(options: {
  from: string;
  to: string;
  subject: string;
  body: string;
  xGmMsgId: string;
  xGmThrid: string;
  dateIso: string;
  labels?: string[];
}): Buffer {
  const labels = options.labels ?? ['\\All'];
  const rfc2822Date = DateTime.fromISO(options.dateIso).toRFC2822();

  return Buffer.from(
    [
      `From: ${options.from}`,
      `To: ${options.to}`,
      `Subject: ${options.subject}`,
      `Date: ${rfc2822Date}`,
      `Message-ID: <server-only-${options.xGmMsgId}@example.com>`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      `X-GM-MSGID: ${options.xGmMsgId}`,
      `X-GM-THRID: ${options.xGmThrid}`,
      `X-GM-LABELS: ${labels.join(' ')}`,
      '',
      options.body,
    ].join('\n'),
    'utf8',
  );
}

async function runAiSearch(
  accountId: number,
  naturalQuery: string,
  mode: 'keyword' | 'semantic',
  folders?: string[],
): Promise<SearchRunResult> {
  const eventBus = TestEventBus.getInstance();
  const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

  const response = await callIpc(
    'ai:search',
    String(accountId),
    naturalQuery,
    folders,
    mode,
  ) as IpcResponse<{ searchToken: string }>;

  expect(response.success).to.equal(true);
  expect(response.data!.searchToken).to.be.a('string');

  const searchToken = response.data!.searchToken;
  const complete = await waitForSearchComplete(searchToken);
  const batches = getSearchBatchesSince(searchToken, priorBatchCount);
  const localMsgIds = batches
    .filter((batch) => batch.phase === 'local')
    .flatMap((batch) => batch.msgIds);
  const imapMsgIds = batches
    .filter((batch) => batch.phase === 'imap')
    .flatMap((batch) => batch.msgIds);

  return {
    searchToken,
    complete,
    batches,
    localMsgIds,
    imapMsgIds,
    allMsgIds: [...localMsgIds, ...imapMsgIds],
  };
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

    imapStateInspector.clearCommandErrors();
    imapStateInspector.setAllowedAccounts([suiteEmail]);

    const ollamaService = OllamaService.getInstance();
    ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
    ollamaService.setModel('');
    ollamaService.setEmbeddingModel('');

    try {
      getDatabase().getDatabase().prepare('DELETE FROM ai_cache').run();
    } catch {
      // AI cache may be unavailable in some test environments.
    }

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

    it('caps IMAP-only streaming results at the hard maximum of 50', async function () {
      this.timeout(30_000);

      const broadSearchTerm = 'streaming-cap-branch-44192';
      const injectedMsgIds: string[] = [];

      for (let index = 0; index < 60; index += 1) {
        const xGmMsgId = (BigInt('7000000000000000') + BigInt(index)).toString();
        const xGmThrid = (BigInt('7100000000000000') + BigInt(index)).toString();
        injectedMsgIds.push(xGmMsgId);

        const rawEmail = createServerOnlyRawEmail({
          from: 'streaming-cap@example.com',
          to: suiteEmail,
          subject: `${broadSearchTerm} subject ${index}`,
          body: `${broadSearchTerm} body ${index}`,
          xGmMsgId,
          xGmThrid,
          dateIso: DateTime.utc(2024, 1, 10, 12, 0, 0).plus({ minutes: index }).toISO()!,
          labels: ['\\All Mail'],
        });

        imapStateInspector.injectMessage('[Gmail]/All Mail', rawEmail, {
          xGmMsgId,
          xGmThrid,
          xGmLabels: ['\\All Mail'],
        });
      }

      ollamaServer.setError('health', true);

      const searchResult = await runAiSearch(
        suiteAccountId,
        broadSearchTerm,
        'keyword',
      );

      expect(searchResult.complete.status).to.equal('complete');
      expect(searchResult.complete.totalResults).to.equal(50);
      expect(searchResult.localMsgIds).to.deep.equal([]);
      expect(searchResult.imapMsgIds).to.have.length(50);
      expect(new Set(searchResult.imapMsgIds).size).to.equal(50);

      for (const msgId of searchResult.imapMsgIds) {
        expect(injectedMsgIds).to.include(msgId);
      }

      expect(injectedMsgIds.some((msgId) => !searchResult.imapMsgIds.includes(msgId))).to.equal(true);

      ollamaServer.setError('health', false);
    });

    it('stops emitting further batches once 50 local semantic results have already been sent', async function () {
      this.timeout(30_000);

      await prepareSemanticPipeline([1, 0, 0, 0]);

      const cappedAccount = seedTestAccount({
        email: 'streaming-cap-semantic@example.com',
        displayName: 'Streaming Cap Semantic',
      });
      const cappedSender = 'semantic-cap-sender@example.com';

      for (let index = 0; index < 55; index += 1) {
        seedLocalEmail({
          accountId: cappedAccount.accountId,
          subject: `semantic-cap-local-${index}`,
          fromAddress: cappedSender,
          dateIso: DateTime.utc(2026, 2, 1, 9, 0, 0).plus({ minutes: index }).toISO()!,
        });
      }

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: '',
        filters: {
          sender: cappedSender,
        },
      }));

      const searchResult = await runAiSearch(
        cappedAccount.accountId,
        'semantic cap local batch query',
        'semantic',
      );

      expect(searchResult.complete.status).to.equal('complete');
      expect(searchResult.complete.totalResults).to.equal(50);
      expect(searchResult.localMsgIds).to.have.length(50);
      expect(searchResult.imapMsgIds).to.deep.equal([]);
      expect(searchResult.batches.filter((batch) => batch.phase === 'local')).to.have.length(1);
      expect(searchResult.batches.filter((batch) => batch.phase === 'imap')).to.deep.equal([]);
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

    it('falls back to IMAP when the email exists locally but its thread row is missing', async function () {
      this.timeout(30_000);

      const missingThreadMsgId = '1000000000000102';
      const missingThreadId = '2000000000000102';
      const missingThreadRaw = createServerOnlyRawEmail({
        from: 'navigate-missing-thread@example.com',
        to: suiteEmail,
        subject: 'Navigate fallback because thread row is missing',
        body: 'This email should fall back to IMAP when the local thread row is deleted.',
        xGmMsgId: missingThreadMsgId,
        xGmThrid: missingThreadId,
        dateIso: DateTime.utc(2024, 1, 8, 12, 0, 0).toISO()!,
        labels: ['\\Inbox', '\\All Mail'],
      });

      imapStateInspector.injectMessage('INBOX', missingThreadRaw, {
        xGmMsgId: missingThreadMsgId,
        xGmThrid: missingThreadId,
        xGmLabels: ['\\Inbox'],
      });
      imapStateInspector.injectMessage('[Gmail]/All Mail', missingThreadRaw, {
        xGmMsgId: missingThreadMsgId,
        xGmThrid: missingThreadId,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 30_000 });

      const databaseService = getDatabase();
      expect(databaseService.getEmailByXGmMsgId(suiteAccountId, missingThreadMsgId)).to.not.equal(null);
      expect(databaseService.getThreadById(suiteAccountId, missingThreadId)).to.not.equal(null);

      databaseService.getDatabase().prepare(
        'DELETE FROM threads WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid',
      ).run({
        accountId: suiteAccountId,
        xGmThrid: missingThreadId,
      });

      expect(databaseService.getThreadById(suiteAccountId, missingThreadId)).to.equal(null);

      const eventBus = TestEventBus.getInstance();
      const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:chat:navigate',
        {
          accountId: suiteAccountId,
          xGmMsgId: missingThreadMsgId,
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
      expect(imapMsgIds).to.include(missingThreadMsgId);
      expect(databaseService.getThreadById(suiteAccountId, missingThreadId)).to.not.equal(null);
    });

    it('continues and emits the IMAP result when the fallback upsert throws', async function () {
      this.timeout(25_000);

      const upsertFailureMsgId = '1000000000000103';
      const upsertFailureThreadId = '2000000000000103';
      const upsertFailureRaw = createServerOnlyRawEmail({
        from: 'navigate-upsert-failure@example.com',
        to: suiteEmail,
        subject: 'Navigate fallback upsert failure',
        body: 'This email should still resolve even if local upsert fails.',
        xGmMsgId: upsertFailureMsgId,
        xGmThrid: upsertFailureThreadId,
        dateIso: DateTime.utc(2024, 1, 9, 12, 0, 0).toISO()!,
        labels: ['\\All Mail'],
      });

      imapStateInspector.injectMessage('[Gmail]/All Mail', upsertFailureRaw, {
        xGmMsgId: upsertFailureMsgId,
        xGmThrid: upsertFailureThreadId,
        xGmLabels: ['\\All Mail'],
      });

      const databaseService = getDatabase() as unknown as {
        getEmailByXGmMsgId: (accountId: number, xGmMsgId: string) => Record<string, unknown> | null;
        upsertEmailFromEnvelope: (...args: unknown[]) => void;
      };
      expect(databaseService.getEmailByXGmMsgId(suiteAccountId, upsertFailureMsgId)).to.equal(null);

      const originalUpsertEmailFromEnvelope = databaseService.upsertEmailFromEnvelope;
      databaseService.upsertEmailFromEnvelope = (..._args: unknown[]): void => {
        throw new Error('forced envelope upsert failure');
      };

      try {
        const eventBus = TestEventBus.getInstance();
        const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

        const response = await callIpc(
          'ai:chat:navigate',
          {
            accountId: suiteAccountId,
            xGmMsgId: upsertFailureMsgId,
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
        expect(imapMsgIds).to.deep.equal([upsertFailureMsgId]);
        expect(databaseService.getEmailByXGmMsgId(suiteAccountId, upsertFailureMsgId)).to.equal(null);
      } finally {
        databaseService.upsertEmailFromEnvelope = originalUpsertEmailFromEnvelope;
      }
    });

    it('handles IMAP FETCH failures during fallback without throwing', async function () {
      this.timeout(25_000);

      const fetchFailureMsgId = '1000000000000104';
      const fetchFailureThreadId = '2000000000000104';
      const fetchFailureRaw = createServerOnlyRawEmail({
        from: 'navigate-fetch-failure@example.com',
        to: suiteEmail,
        subject: 'Navigate fallback fetch failure',
        body: 'This email exists on the server but FETCH will fail during fallback.',
        xGmMsgId: fetchFailureMsgId,
        xGmThrid: fetchFailureThreadId,
        dateIso: DateTime.utc(2024, 1, 10, 12, 0, 0).toISO()!,
        labels: ['\\All Mail'],
      });

      imapStateInspector.injectMessage('[Gmail]/All Mail', fetchFailureRaw, {
        xGmMsgId: fetchFailureMsgId,
        xGmThrid: fetchFailureThreadId,
        xGmLabels: ['\\All Mail'],
      });
      imapStateInspector.injectCommandError('FETCH', 'FETCH failed');

      const eventBus = TestEventBus.getInstance();
      const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

      const response = await callIpc(
        'ai:chat:navigate',
        {
          accountId: suiteAccountId,
          xGmMsgId: fetchFailureMsgId,
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

    it('handles unexpected local database lookup failures without throwing', async function () {
      this.timeout(25_000);

      const databaseService = getDatabase() as unknown as {
        getEmailByXGmMsgId: (accountId: number, xGmMsgId: string) => Record<string, unknown> | null;
      };
      const originalGetEmailByXGmMsgId = databaseService.getEmailByXGmMsgId;
      databaseService.getEmailByXGmMsgId = (_accountId: number, _xGmMsgId: string): Record<string, unknown> | null => {
        throw new Error('forced local lookup failure');
      };

      try {
        const response = await callIpc(
          'ai:chat:navigate',
          {
            accountId: suiteAccountId,
            xGmMsgId: 'forced-fatal-path-msg-id',
          },
        ) as IpcResponse<{ searchToken: string }>;

        expect(response.success).to.equal(true);

        const complete = await waitForSearchComplete(response.data!.searchToken);
        expect(complete.status).to.equal('complete');
        expect(complete.totalResults).to.equal(0);
      } finally {
        databaseService.getEmailByXGmMsgId = originalGetEmailByXGmMsgId;
      }
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

    it('supports semantic filter-only searches with date ranges, sender, recipient, and folder filters', async function () {
      this.timeout(30_000);

      await prepareSemanticPipeline([1, 0, 0, 0]);

      const dateAccount = seedTestAccount({
        email: 'semantic-date-filter@example.com',
        displayName: 'Semantic Date Filter',
      });
      const beforeDateEmail = seedLocalEmail({
        accountId: dateAccount.accountId,
        subject: 'semantic-date-before-window',
        dateIso: DateTime.utc(2026, 1, 1, 9, 0, 0).toISO()!,
        fromAddress: 'date-before@example.com',
      });
      const inRangeEmail = seedLocalEmail({
        accountId: dateAccount.accountId,
        subject: 'semantic-date-in-window',
        dateIso: DateTime.utc(2026, 1, 3, 9, 0, 0).toISO()!,
        fromAddress: 'date-match@example.com',
      });
      seedLocalEmail({
        accountId: dateAccount.accountId,
        subject: 'semantic-date-after-window',
        dateIso: DateTime.utc(2026, 1, 8, 9, 0, 0).toISO()!,
        fromAddress: 'date-after@example.com',
      });

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: '',
        filters: {
          dateFrom: '2026-01-02',
          dateTo: '2026-01-05',
        },
      }));

      const dateSearch = await runAiSearch(
        dateAccount.accountId,
        'semantic-date-filter-query-2026-window',
        'semantic',
      );

      expect(dateSearch.complete.status).to.equal('complete');
      expect(dateSearch.localMsgIds).to.deep.equal([inRangeEmail.xGmMsgId]);
      expect(dateSearch.imapMsgIds).to.deep.equal([]);
      expect(dateSearch.allMsgIds).to.not.include(beforeDateEmail.xGmMsgId);

      const senderAccount = seedTestAccount({
        email: 'semantic-sender-filter@example.com',
        displayName: 'Semantic Sender Filter',
      });
      const senderMatch = seedLocalEmail({
        accountId: senderAccount.accountId,
        subject: 'semantic-sender-match',
        fromAddress: 'semantic-sender-match@example.com',
        fromName: 'Semantic Sender Match',
        toAddresses: 'recipient@example.com',
      });
      seedLocalEmail({
        accountId: senderAccount.accountId,
        subject: 'semantic-sender-other',
        fromAddress: 'semantic-sender-other@example.com',
        fromName: 'Semantic Sender Other',
        toAddresses: 'recipient@example.com',
      });

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: '',
        filters: {
          sender: 'Semantic Sender Match',
        },
      }));

      const senderSearch = await runAiSearch(
        senderAccount.accountId,
        'semantic-sender-filter-query-match-name',
        'semantic',
      );

      expect(senderSearch.complete.status).to.equal('complete');
      expect(senderSearch.allMsgIds).to.deep.equal([senderMatch.xGmMsgId]);

      const recipientAccount = seedTestAccount({
        email: 'semantic-recipient-filter@example.com',
        displayName: 'Semantic Recipient Filter',
      });
      const recipientMatch = seedLocalEmail({
        accountId: recipientAccount.accountId,
        subject: 'semantic-recipient-match',
        fromAddress: 'sender@example.com',
        toAddresses: 'semantic-recipient-match@example.com',
      });
      seedLocalEmail({
        accountId: recipientAccount.accountId,
        subject: 'semantic-recipient-other',
        fromAddress: 'sender@example.com',
        toAddresses: 'semantic-recipient-other@example.com',
      });

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: '',
        filters: {
          recipient: 'semantic-recipient-match@example.com',
        },
      }));

      const recipientSearch = await runAiSearch(
        recipientAccount.accountId,
        'semantic-recipient-filter-query-match-address',
        'semantic',
      );

      expect(recipientSearch.complete.status).to.equal('complete');
      expect(recipientSearch.allMsgIds).to.deep.equal([recipientMatch.xGmMsgId]);

      const folderAccount = seedTestAccount({
        email: 'semantic-folder-filter@example.com',
        displayName: 'Semantic Folder Filter',
      });
      const folderMatch = seedLocalEmail({
        accountId: folderAccount.accountId,
        subject: 'semantic-folder-match',
        fromAddress: 'folder-match@example.com',
        folders: ['Projects Alpha'],
      });
      seedLocalEmail({
        accountId: folderAccount.accountId,
        subject: 'semantic-folder-other',
        fromAddress: 'folder-other@example.com',
        folders: ['INBOX'],
      });

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: '',
        filters: {
          folder: 'Projects Alpha',
        },
      }));

      const folderSearch = await runAiSearch(
        folderAccount.accountId,
        'semantic-folder-filter-query-projects-alpha',
        'semantic',
      );

      expect(folderSearch.complete.status).to.equal('complete');
      expect(folderSearch.allMsgIds).to.deep.equal([folderMatch.xGmMsgId]);
    });

    it('supports all boolean semantic filter combinations and combined filter-only searches', async function () {
      this.timeout(35_000);

      await prepareSemanticPipeline([1, 0, 0, 0]);

      const boolAccount = seedTestAccount({
        email: 'semantic-boolean-filters@example.com',
        displayName: 'Semantic Boolean Filters',
      });
      const uniqueSender = 'semantic-bool-sender@example.com';
      const comboExpectations = new Map<string, string>();

      for (const hasAttachment of [true, false]) {
        for (const isRead of [true, false]) {
          for (const isStarred of [true, false]) {
            const comboKey = `${hasAttachment}-${isRead}-${isStarred}`;
            const comboEmail = seedLocalEmail({
              accountId: boolAccount.accountId,
              subject: `semantic-bool-${comboKey}`,
              fromAddress: uniqueSender,
              toAddresses: 'semantic-bool@example.com',
              hasAttachments: hasAttachment,
              isRead,
              isStarred,
              dateIso: DateTime.utc(2026, 2, 1, 9, 0, 0).plus({ minutes: comboExpectations.size }).toISO()!,
            });
            comboExpectations.set(comboKey, comboEmail.xGmMsgId);
          }
        }
      }

      for (const [comboKey, expectedMsgId] of comboExpectations.entries()) {
        const [hasAttachmentRaw, isReadRaw, isStarredRaw] = comboKey.split('-');

        ollamaServer.setChatResponse(JSON.stringify({
          semanticQuery: '',
          filters: {
            sender: uniqueSender,
            hasAttachment: hasAttachmentRaw === 'true',
            isRead: isReadRaw === 'true',
            isStarred: isStarredRaw === 'true',
          },
        }));

        const searchResult = await runAiSearch(
          boolAccount.accountId,
          `semantic-boolean-combo-${comboKey}-${expectedMsgId}`,
          'semantic',
        );

        expect(searchResult.complete.status).to.equal('complete');
        expect(searchResult.allMsgIds).to.deep.equal([expectedMsgId]);
      }

      const combinedAccount = seedTestAccount({
        email: 'semantic-combined-filters@example.com',
        displayName: 'Semantic Combined Filters',
      });
      const combinedTarget = seedLocalEmail({
        accountId: combinedAccount.accountId,
        subject: 'semantic-combined-target',
        fromAddress: 'combined-match@example.com',
        toAddresses: 'combined-recipient@example.com',
        folders: ['Finance Archive'],
        dateIso: DateTime.utc(2026, 3, 15, 12, 0, 0).toISO()!,
        hasAttachments: true,
        isRead: false,
        isStarred: true,
      });
      seedLocalEmail({
        accountId: combinedAccount.accountId,
        subject: 'semantic-combined-near-miss',
        fromAddress: 'combined-match@example.com',
        toAddresses: 'combined-recipient@example.com',
        folders: ['Finance Archive'],
        dateIso: DateTime.utc(2026, 3, 16, 12, 0, 0).toISO()!,
        hasAttachments: true,
        isRead: true,
        isStarred: true,
      });

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: '',
        filters: {
          dateFrom: '2026-03-10',
          dateTo: '2026-03-20',
          folder: 'Finance Archive',
          sender: 'combined-match@example.com',
          recipient: 'combined-recipient@example.com',
          hasAttachment: true,
          isRead: false,
          isStarred: true,
        },
      }));

      const combinedSearch = await runAiSearch(
        combinedAccount.accountId,
        'semantic-combined-filter-query-all-constraints',
        'semantic',
      );

      expect(combinedSearch.complete.status).to.equal('complete');
      expect(combinedSearch.allMsgIds).to.deep.equal([combinedTarget.xGmMsgId]);
    });

    it('returns error when semantic embedding fails, excludes Trash/Spam/Drafts, resolves mixed local and IMAP candidates, and marks IMAP connect failures as partial', async function () {
      this.timeout(35_000);

      await prepareSemanticPipeline([1, 0, 0, 0]);

      const embedFailureAccount = seedTestAccount({
        email: 'semantic-embed-failure@example.com',
        displayName: 'Semantic Embed Failure',
      });
      const embedFailureEmail = seedLocalEmail({
        accountId: embedFailureAccount.accountId,
        subject: 'semantic embed failure target',
        fromAddress: 'embed-failure@example.com',
        textBody: 'semantic embed failure body',
      });
      insertSemanticChunk(embedFailureAccount.accountId, embedFailureEmail.xGmMsgId, 'semantic embed failure chunk', [1, 0, 0, 0]);

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: 'semantic embed failure chunk',
        filters: {},
      }));
      ollamaServer.setError('embed', true);

      const embedFailureSearch = await runAiSearch(
        embedFailureAccount.accountId,
        'semantic-embed-failure-query',
        'semantic',
      );

      expect(embedFailureSearch.complete.status).to.equal('error');
      expect(embedFailureSearch.batches).to.deep.equal([]);

      ollamaServer.setError('embed', false);

      const excludedFoldersAccount = seedTestAccount({
        email: 'semantic-excluded-folders@example.com',
        displayName: 'Semantic Excluded Folders',
      });
      const includedInboxEmail = seedLocalEmail({
        accountId: excludedFoldersAccount.accountId,
        subject: 'semantic inbox include',
        fromAddress: 'included@example.com',
        folders: ['INBOX'],
      });
      const trashOnlyEmail = seedLocalEmail({
        accountId: excludedFoldersAccount.accountId,
        subject: 'semantic trash exclude',
        fromAddress: 'trash@example.com',
        folders: ['[Gmail]/Trash'],
      });
      const spamOnlyEmail = seedLocalEmail({
        accountId: excludedFoldersAccount.accountId,
        subject: 'semantic spam exclude',
        fromAddress: 'spam@example.com',
        folders: ['[Gmail]/Spam'],
      });
      const draftsOnlyEmail = seedLocalEmail({
        accountId: excludedFoldersAccount.accountId,
        subject: 'semantic drafts exclude',
        fromAddress: 'drafts@example.com',
        folders: ['[Gmail]/Drafts'],
        isDraft: true,
      });

      for (const msgId of [
        includedInboxEmail.xGmMsgId,
        trashOnlyEmail.xGmMsgId,
        spamOnlyEmail.xGmMsgId,
        draftsOnlyEmail.xGmMsgId,
      ]) {
        insertSemanticChunk(excludedFoldersAccount.accountId, msgId, 'semantic excluded folders chunk', [1, 0, 0, 0]);
      }

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: 'semantic excluded folders chunk',
        filters: {},
      }));

      const excludedFoldersSearch = await runAiSearch(
        excludedFoldersAccount.accountId,
        'semantic-excluded-folders-query',
        'semantic',
      );

      expect(excludedFoldersSearch.complete.status).to.equal('complete');
      expect(excludedFoldersSearch.localMsgIds).to.deep.equal([includedInboxEmail.xGmMsgId]);
      expect(excludedFoldersSearch.allMsgIds).to.not.include(trashOnlyEmail.xGmMsgId);
      expect(excludedFoldersSearch.allMsgIds).to.not.include(spamOnlyEmail.xGmMsgId);
      expect(excludedFoldersSearch.allMsgIds).to.not.include(draftsOnlyEmail.xGmMsgId);

      const mixedResolutionAccount = seedTestAccount({
        email: 'semantic-mixed-resolution@example.com',
        displayName: 'Semantic Mixed Resolution',
      });
      const localSemanticEmail = seedLocalEmail({
        accountId: mixedResolutionAccount.accountId,
        subject: 'semantic mixed local',
        fromAddress: 'semantic-local@example.com',
        textBody: 'local semantic mixed body',
      });
      const missingIdentifiers = createSyntheticIdentifiers();
      const missingDateIso = DateTime.utc(2026, 4, 5, 14, 0, 0).toISO()!;

      insertSemanticChunk(mixedResolutionAccount.accountId, localSemanticEmail.xGmMsgId, 'semantic mixed result chunk', [1, 0, 0, 0]);
      insertSemanticChunk(mixedResolutionAccount.accountId, missingIdentifiers.xGmMsgId, 'semantic mixed result chunk', [0.92, 0, 0, 0]);

      const serverOnlyRaw = createServerOnlyRawEmail({
        from: 'semantic-server-only@example.com',
        to: mixedResolutionAccount.email,
        subject: 'semantic mixed server only',
        body: 'This server-only semantic result should resolve through IMAP.',
        xGmMsgId: missingIdentifiers.xGmMsgId,
        xGmThrid: missingIdentifiers.xGmThrid,
        dateIso: missingDateIso,
      });
      imapStateInspector.injectMessage('[Gmail]/All Mail', serverOnlyRaw, {
        xGmMsgId: missingIdentifiers.xGmMsgId,
        xGmThrid: missingIdentifiers.xGmThrid,
        xGmLabels: ['\\All'],
      });

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: 'semantic mixed result chunk',
        filters: {},
      }));

      const mixedResolutionSearch = await runAiSearch(
        mixedResolutionAccount.accountId,
        'semantic-mixed-local-and-missing-query',
        'semantic',
      );

      expect(mixedResolutionSearch.complete.status).to.equal('complete');
      expect(mixedResolutionSearch.localMsgIds).to.include(localSemanticEmail.xGmMsgId);
      expect(mixedResolutionSearch.imapMsgIds).to.include(missingIdentifiers.xGmMsgId);
      expect(getDatabase().getEmailByXGmMsgId(mixedResolutionAccount.accountId, missingIdentifiers.xGmMsgId)).to.not.equal(null);

      const partialAccount = seedTestAccount({
        email: 'semantic-imap-partial@example.com',
        displayName: 'Semantic Partial Result',
      });
      const partialLocalEmail = seedLocalEmail({
        accountId: partialAccount.accountId,
        subject: 'semantic partial local',
        fromAddress: 'semantic-partial@example.com',
      });
      const partialMissingIdentifiers = createSyntheticIdentifiers();

      insertSemanticChunk(partialAccount.accountId, partialLocalEmail.xGmMsgId, 'semantic partial resolution chunk', [1, 0, 0, 0]);
      insertSemanticChunk(partialAccount.accountId, partialMissingIdentifiers.xGmMsgId, 'semantic partial resolution chunk', [0.91, 0, 0, 0]);

      ollamaServer.setChatResponse(JSON.stringify({
        semanticQuery: 'semantic partial resolution chunk',
        filters: {},
      }));
      imapStateInspector.setAllowedAccounts([suiteEmail]);

      const partialSearch = await runAiSearch(
        partialAccount.accountId,
        'semantic-partial-imap-connect-failure-query',
        'semantic',
      );

      expect(partialSearch.complete.status).to.equal('partial');
      expect(partialSearch.localMsgIds).to.deep.equal([partialLocalEmail.xGmMsgId]);
      expect(partialSearch.imapMsgIds).to.deep.equal([]);
      expect(partialSearch.complete.totalResults).to.equal(1);
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

  describe('ai:search — keyword operator coverage', () => {
    it('supports from:, to:, subject:, and body: keyword operators', async function () {
      this.timeout(30_000);

      const operatorAccount = seedTestAccount({
        email: 'keyword-operators@example.com',
        displayName: 'Keyword Operators',
      });
      const uniqueSuffix = String(DateTime.utc().toMillis());

      const fromEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: `from-operator-${uniqueSuffix}`,
        fromAddress: 'keyword-from@example.com',
        textBody: `from operator body ${uniqueSuffix}`,
      });
      const toEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: `to-operator-${uniqueSuffix}`,
        fromAddress: 'keyword-to-sender@example.com',
        toAddresses: 'keyword-to@example.com',
        textBody: `to operator body ${uniqueSuffix}`,
      });
      const subjectEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: `subject-marker-${uniqueSuffix}`,
        fromAddress: 'keyword-subject@example.com',
        textBody: 'subject operator body',
      });
      const bodyEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: `body-operator-${uniqueSuffix}`,
        fromAddress: 'keyword-body@example.com',
        textBody: '',
        htmlBody: `<p>html-body-marker-${uniqueSuffix}</p>`,
      });

      const fromSearch = await runAiSearch(
        operatorAccount.accountId,
        `from:keyword-from@example.com from-operator-${uniqueSuffix}`,
        'keyword',
      );
      const toSearch = await runAiSearch(
        operatorAccount.accountId,
        `to:keyword-to@example.com to-operator-${uniqueSuffix}`,
        'keyword',
      );
      const subjectSearch = await runAiSearch(
        operatorAccount.accountId,
        `subject:subject-marker-${uniqueSuffix}`,
        'keyword',
      );
      const bodySearch = await runAiSearch(
        operatorAccount.accountId,
        `body:html-body-marker-${uniqueSuffix} body-operator-${uniqueSuffix}`,
        'keyword',
      );

      expect(fromSearch.complete.status).to.equal('complete');
      expect(fromSearch.allMsgIds).to.deep.equal([fromEmail.xGmMsgId]);
      expect(toSearch.allMsgIds).to.deep.equal([toEmail.xGmMsgId]);
      expect(subjectSearch.allMsgIds).to.deep.equal([subjectEmail.xGmMsgId]);
      expect(bodySearch.allMsgIds).to.deep.equal([bodyEmail.xGmMsgId]);
    });

    it('supports folder aliases including inbox and sent, and safely handles trash aliases with default and resolved trash folders', async function () {
      this.timeout(30_000);

      const aliasAccount = seedTestAccount({
        email: 'keyword-folder-aliases@example.com',
        displayName: 'Keyword Folder Aliases',
      });
      const inboxEmail = seedLocalEmail({
        accountId: aliasAccount.accountId,
        subject: 'keyword-inbox-alias-marker',
        fromAddress: 'keyword-inbox@example.com',
        folders: ['INBOX'],
      });
      const sentEmail = seedLocalEmail({
        accountId: aliasAccount.accountId,
        subject: 'keyword-sent-alias-marker',
        fromAddress: 'keyword-sent@example.com',
        folders: ['[Gmail]/Sent Mail'],
      });
      const fallbackTrashAccount = seedTestAccount({
        email: 'keyword-trash-fallback@example.com',
        displayName: 'Keyword Trash Fallback',
      });
      const trashFallbackEmail = seedLocalEmail({
        accountId: fallbackTrashAccount.accountId,
        subject: 'keyword-trash-fallback-marker',
        fromAddress: 'keyword-trash-fallback@example.com',
        folders: ['[Gmail]/Trash'],
      });

      const resolvedTrashAccount = seedTestAccount({
        email: 'keyword-trash-resolved@example.com',
        displayName: 'Keyword Trash Resolved',
      });
      seedLabelForAccount({
        accountId: resolvedTrashAccount.accountId,
        gmailLabelId: '[Gmail]/Bin',
        name: 'Trash',
        type: 'system',
        specialUse: '\\Trash',
      });
      const trashResolvedEmail = seedLocalEmail({
        accountId: resolvedTrashAccount.accountId,
        subject: 'keyword-trash-resolved-marker',
        fromAddress: 'keyword-trash-resolved@example.com',
        folders: ['[Gmail]/Bin'],
      });

      const inboxSearch = await runAiSearch(aliasAccount.accountId, 'in:inbox keyword-inbox-alias-marker', 'keyword');
      const sentSearch = await runAiSearch(aliasAccount.accountId, 'in:sent keyword-sent-alias-marker', 'keyword');
      const trashFallbackSearch = await runAiSearch(
        fallbackTrashAccount.accountId,
        'in:trash keyword-trash-fallback-marker',
        'keyword',
      );
      const trashResolvedSearch = await runAiSearch(
        resolvedTrashAccount.accountId,
        'in:trash keyword-trash-resolved-marker',
        'keyword',
      );

      expect(inboxSearch.allMsgIds).to.deep.equal([inboxEmail.xGmMsgId]);
      expect(sentSearch.allMsgIds).to.deep.equal([sentEmail.xGmMsgId]);
      expect(trashFallbackSearch.complete.status).to.equal('complete');
      expect(trashResolvedSearch.complete.status).to.equal('complete');
      expect(trashFallbackSearch.allMsgIds).to.deep.equal([]);
      expect(trashResolvedSearch.allMsgIds).to.deep.equal([]);
      expect(trashFallbackSearch.complete.totalResults).to.equal(0);
      expect(trashResolvedSearch.complete.totalResults).to.equal(0);
    });

    it('supports label:, is:unread, is:starred, is:important, and has:attachment keyword operators', async function () {
      this.timeout(30_000);

      const operatorAccount = seedTestAccount({
        email: 'keyword-label-and-flags@example.com',
        displayName: 'Keyword Label And Flags',
      });
      seedLabelForAccount({
        accountId: operatorAccount.accountId,
        gmailLabelId: 'Projects/Alpha',
        name: 'Project Alpha',
      });

      const labelEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: 'keyword-label-marker',
        fromAddress: 'keyword-label@example.com',
        folders: ['Projects/Alpha'],
      });
      const unreadEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: 'keyword-unread-marker',
        fromAddress: 'keyword-unread@example.com',
        isRead: false,
      });
      const starredEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: 'keyword-starred-marker',
        fromAddress: 'keyword-starred@example.com',
        isStarred: true,
      });
      const importantEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: 'keyword-important-marker',
        fromAddress: 'keyword-important@example.com',
        isImportant: true,
      });
      const attachmentEmail = seedLocalEmail({
        accountId: operatorAccount.accountId,
        subject: 'keyword-attachment-marker',
        fromAddress: 'keyword-attachment@example.com',
        hasAttachments: true,
      });

      const labelSearch = await runAiSearch(
        operatorAccount.accountId,
        'label:"Project Alpha" keyword-label-marker',
        'keyword',
      );
      const unreadSearch = await runAiSearch(operatorAccount.accountId, 'is:unread keyword-unread-marker', 'keyword');
      const starredSearch = await runAiSearch(operatorAccount.accountId, 'is:starred keyword-starred-marker', 'keyword');
      const importantSearch = await runAiSearch(operatorAccount.accountId, 'is:important keyword-important-marker', 'keyword');
      const attachmentSearch = await runAiSearch(operatorAccount.accountId, 'has:attachment keyword-attachment-marker', 'keyword');

      expect(labelSearch.allMsgIds).to.deep.equal([labelEmail.xGmMsgId]);
      expect(unreadSearch.allMsgIds).to.deep.equal([unreadEmail.xGmMsgId]);
      expect(starredSearch.allMsgIds).to.deep.equal([starredEmail.xGmMsgId]);
      expect(importantSearch.allMsgIds).to.deep.equal([importantEmail.xGmMsgId]);
      expect(attachmentSearch.allMsgIds).to.deep.equal([attachmentEmail.xGmMsgId]);
    });

    it('supports after:, before:, newer_than:, and older_than: keyword date operators', async function () {
      this.timeout(30_000);

      const dateAccount = seedTestAccount({
        email: 'keyword-date-operators@example.com',
        displayName: 'Keyword Date Operators',
      });
      const afterEmail = seedLocalEmail({
        accountId: dateAccount.accountId,
        subject: 'after-date-marker',
        fromAddress: 'after-date@example.com',
        dateIso: DateTime.utc(2026, 2, 10, 8, 0, 0).toISO()!,
      });
      const beforeEmail = seedLocalEmail({
        accountId: dateAccount.accountId,
        subject: 'before-date-marker',
        fromAddress: 'before-date@example.com',
        dateIso: DateTime.utc(2026, 1, 5, 8, 0, 0).toISO()!,
      });
      const recentRelativeEmail = seedLocalEmail({
        accountId: dateAccount.accountId,
        subject: 'relative-recent-marker',
        fromAddress: 'relative-recent@example.com',
        dateIso: DateTime.utc().minus({ days: 2 }).toISO()!,
      });
      const olderRelativeEmail = seedLocalEmail({
        accountId: dateAccount.accountId,
        subject: 'relative-old-marker',
        fromAddress: 'relative-old@example.com',
        dateIso: DateTime.utc().minus({ months: 4 }).toISO()!,
      });

      const afterSearch = await runAiSearch(dateAccount.accountId, 'after:2026/02/01 after-date-marker', 'keyword');
      const beforeSearch = await runAiSearch(dateAccount.accountId, 'before:2026/01/10 before-date-marker', 'keyword');
      const newerThanSearch = await runAiSearch(dateAccount.accountId, 'newer_than:7d relative-recent-marker', 'keyword');
      const olderThanSearch = await runAiSearch(dateAccount.accountId, 'older_than:3m relative-old-marker', 'keyword');
      const recentRelativeStoredDate = DateTime.fromISO(
        getDatabase().getEmailByXGmMsgId(dateAccount.accountId, recentRelativeEmail.xGmMsgId)!['date'] as string,
      );
      const olderRelativeStoredDate = DateTime.fromISO(
        getDatabase().getEmailByXGmMsgId(dateAccount.accountId, olderRelativeEmail.xGmMsgId)!['date'] as string,
      );

      expect(afterSearch.allMsgIds).to.deep.equal([afterEmail.xGmMsgId]);
      expect(beforeSearch.allMsgIds).to.deep.equal([beforeEmail.xGmMsgId]);
      expect(newerThanSearch.allMsgIds).to.deep.equal([recentRelativeEmail.xGmMsgId]);
      expect(olderThanSearch.allMsgIds).to.deep.equal([olderRelativeEmail.xGmMsgId]);
      expect(recentRelativeStoredDate.toMillis()).to.be.greaterThan(DateTime.utc().minus({ days: 7 }).toMillis());
      expect(recentRelativeStoredDate.toMillis()).to.be.lessThan(DateTime.utc().toMillis());
      expect(olderRelativeStoredDate.toMillis()).to.be.lessThan(DateTime.utc().minus({ months: 3 }).toMillis());
    });

    it('supports negated operators, quoted phrases, unknown operators, explicit keyword empty-query validation, and SQL wildcard escaping', async function () {
      this.timeout(35_000);

      const negationAccount = seedTestAccount({
        email: 'keyword-negations@example.com',
        displayName: 'Keyword Negations',
      });
      seedLocalEmail({
        accountId: negationAccount.accountId,
        subject: 'negated-from-marker',
        fromAddress: 'blocked-sender@example.com',
        textBody: 'negated-from-marker',
      });
      const negatedFromAllowedEmail = seedLocalEmail({
        accountId: negationAccount.accountId,
        subject: 'negated-from-marker',
        fromAddress: 'allowed-sender@example.com',
        textBody: 'negated-from-marker',
      });
      seedLocalEmail({
        accountId: negationAccount.accountId,
        subject: 'negated-read-marker',
        fromAddress: 'read-email@example.com',
        isRead: true,
      });
      const negatedUnreadEmail = seedLocalEmail({
        accountId: negationAccount.accountId,
        subject: 'negated-read-marker',
        fromAddress: 'unread-email@example.com',
        isRead: false,
      });
      const phraseEmail = seedLocalEmail({
        accountId: negationAccount.accountId,
        subject: 'phrase-search-marker',
        fromAddress: 'phrase@example.com',
        textBody: 'This message contains the exact phrase quarterly planning review for testing.',
      });
      const unknownOperatorEmail = seedLocalEmail({
        accountId: negationAccount.accountId,
        subject: 'unknown-operator-marker',
        fromAddress: 'unknown-operator@example.com',
        textBody: 'This body includes mystery:literal unknown-operator-marker.',
      });
      const wildcardLiteralEmail = seedLocalEmail({
        accountId: negationAccount.accountId,
        subject: 'wildcard-escape-marker 100%_complete',
        fromAddress: 'wildcard-literal@example.com',
      });
      seedLocalEmail({
        accountId: negationAccount.accountId,
        subject: 'wildcard-escape-marker 100Xacomplete',
        fromAddress: 'wildcard-near-match@example.com',
      });

      const negatedFromSearch = await runAiSearch(
        negationAccount.accountId,
        '-from:blocked-sender@example.com negated-from-marker',
        'keyword',
      );
      const negatedReadSearch = await runAiSearch(
        negationAccount.accountId,
        '-is:read negated-read-marker',
        'keyword',
      );
      const phraseSearch = await runAiSearch(
        negationAccount.accountId,
        '"quarterly planning review" phrase-search-marker',
        'keyword',
      );
      const unknownOperatorSearch = await runAiSearch(
        negationAccount.accountId,
        'mystery:literal unknown-operator-marker',
        'keyword',
      );
      const wildcardSearch = await runAiSearch(
        negationAccount.accountId,
        'subject:100%_complete wildcard-escape-marker',
        'keyword',
      );

      expect(negatedFromSearch.allMsgIds).to.deep.equal([negatedFromAllowedEmail.xGmMsgId]);
      expect(negatedReadSearch.allMsgIds).to.deep.equal([negatedUnreadEmail.xGmMsgId]);
      expect(phraseSearch.allMsgIds).to.deep.equal([phraseEmail.xGmMsgId]);
      expect(unknownOperatorSearch.allMsgIds).to.deep.equal([unknownOperatorEmail.xGmMsgId]);
      expect(wildcardSearch.allMsgIds).to.deep.equal([wildcardLiteralEmail.xGmMsgId]);

      const emptyKeywordResponse = await callIpc(
        'ai:search',
        String(negationAccount.accountId),
        '',
        undefined,
        'keyword',
      ) as IpcResponse<unknown>;

      expect(emptyKeywordResponse.success).to.equal(false);
      expect(emptyKeywordResponse.error!.code).to.equal('AI_INVALID_INPUT');
    });

    it('treats blank label operators as no-op filters and still completes the keyword search', async function () {
      this.timeout(25_000);

      const blankLabelAccount = seedTestAccount({
        email: 'keyword-blank-label@example.com',
        displayName: 'Keyword Blank Label',
      });
      const blankLabelEmail = seedLocalEmail({
        accountId: blankLabelAccount.accountId,
        subject: 'keyword-blank-label-marker',
        fromAddress: 'keyword-blank-label@example.com',
      });

      ollamaServer.setError('health', true);

      const blankLabelSearch = await runAiSearch(
        blankLabelAccount.accountId,
        'label:""',
        'keyword',
      );

      expect(blankLabelSearch.complete.status).to.equal('complete');
      expect(blankLabelSearch.complete.totalResults).to.equal(1);
      expect(blankLabelSearch.allMsgIds).to.deep.equal([blankLabelEmail.xGmMsgId]);

      ollamaServer.setError('health', false);
    });

    it('falls back to literal text search for unsupported is: operators', async function () {
      this.timeout(25_000);

      const unsupportedIsAccount = seedTestAccount({
        email: 'keyword-unsupported-is@example.com',
        displayName: 'Keyword Unsupported Is',
      });
      const unsupportedIsEmail = seedLocalEmail({
        accountId: unsupportedIsAccount.accountId,
        subject: 'keyword-unsupported-is-marker',
        fromAddress: 'keyword-unsupported-is@example.com',
        textBody: 'This email contains the literal token is:muted for parser coverage.',
      });

      ollamaServer.setError('health', true);

      const unsupportedIsSearch = await runAiSearch(
        unsupportedIsAccount.accountId,
        'is:muted keyword-unsupported-is-marker',
        'keyword',
      );

      expect(unsupportedIsSearch.complete.status).to.equal('complete');
      expect(unsupportedIsSearch.allMsgIds).to.deep.equal([unsupportedIsEmail.xGmMsgId]);

      ollamaServer.setError('health', false);
    });

    it('falls back to literal text search for unsupported has: operators', async function () {
      this.timeout(25_000);

      const unsupportedHasAccount = seedTestAccount({
        email: 'keyword-unsupported-has@example.com',
        displayName: 'Keyword Unsupported Has',
      });
      const unsupportedHasEmail = seedLocalEmail({
        accountId: unsupportedHasAccount.accountId,
        subject: 'keyword-unsupported-has-marker has:drive',
        fromAddress: 'keyword-unsupported-has@example.com',
        textBody: 'This email contains the literal token has:drive for parser coverage.',
      });

      ollamaServer.setError('health', true);

      const unsupportedHasSearch = await runAiSearch(
        unsupportedHasAccount.accountId,
        'has:drive keyword-unsupported-has-marker',
        'keyword',
      );

      expect(unsupportedHasSearch.complete.status).to.equal('complete');
      expect(unsupportedHasSearch.allMsgIds).to.deep.equal([unsupportedHasEmail.xGmMsgId]);

      ollamaServer.setError('health', false);
    });

    it('parser covers blank label, no-account label, unsupported operators, negated relative dates, and empty-query fallback branches', () => {
      const blankLabelParsed = parseGmailQuery('label:""', {
        accountId: 123,
        paramPrefix: 'raw-prefix!@#',
      });
      expect(blankLabelParsed.whereClause).to.equal('1=1');
      expect(blankLabelParsed.params).to.deep.equal({});

      const labelWithoutAccountParsed = parseGmailQuery('label:ProjectAlpha');
      expect(labelWithoutAccountParsed.whereClause).to.equal('1 = 0');

      const negatedLabelWithoutAccountParsed = parseGmailQuery('-label:ProjectAlpha');
      expect(negatedLabelWithoutAccountParsed.whereClause).to.equal('1 = 1');

      const unsupportedIsParsed = parseGmailQuery('is:muted');
      expect(unsupportedIsParsed.whereClause).to.include('e.subject LIKE');
      expect(Object.values(unsupportedIsParsed.params)).to.deep.equal(['%is:muted%']);

      const unsupportedHasParsed = parseGmailQuery('has:drive');
      expect(unsupportedHasParsed.whereClause).to.include('e.subject LIKE');
      expect(Object.values(unsupportedHasParsed.params)).to.deep.equal(['%has:drive%']);

      const negatedBeforeParsed = parseGmailQuery('-before:2026/03/12');
      expect(negatedBeforeParsed.whereClause).to.equal('e.date >= :sqp1');

      const negatedNewerThanParsed = parseGmailQuery('-newer_than:7d');
      expect(negatedNewerThanParsed.whereClause).to.equal('e.date < :sqp1');

      const negatedOlderThanParsed = parseGmailQuery('-older_than:3m');
      expect(negatedOlderThanParsed.whereClause).to.equal('e.date >= :sqp1');

      const trashAliasWithoutResolverParsed = parseGmailQuery('in:trash');
      expect(trashAliasWithoutResolverParsed.whereClause).to.include('LOWER(ef_in.folder) = :sqp1');
      expect(trashAliasWithoutResolverParsed.params['sqp1']).to.equal('[gmail]/trash');

      const emptyParsed = parseGmailQuery('   ');
      expect(emptyParsed.whereClause).to.equal('1=1');
      expect(emptyParsed.params).to.deep.equal({});
    });
  });
});
