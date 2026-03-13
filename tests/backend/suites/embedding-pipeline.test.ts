import { expect } from 'chai';
import { DateTime } from 'luxon';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  getDatabase,
  seedTestAccount,
  waitForEvent,
} from '../infrastructure/test-helpers';
import { imapStateInspector, ollamaServer } from '../test-main';
import { TestEventBus } from '../infrastructure/test-event-bus';
import { emlFixtures, MessageFixtureName } from '../fixtures/index';
import { OllamaService } from '../../../electron/services/ollama-service';
import { VectorDbService } from '../../../electron/services/vector-db-service';
import { EmbeddingService } from '../../../electron/services/embedding-service';

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface EmbeddingStatusResponse {
  embeddingModel: string | null;
  indexStatus: string;
  indexed: number;
  total: number;
  vectorDimension: number | null;
}

interface EmbeddingProgressPayload {
  indexed: number;
  total: number;
  percent: number;
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

const SUITE_EMAIL = 'embedding-pipeline@example.com';
const SUITE_DISPLAY_NAME = 'Embedding Pipeline User';

let suiteAccountId: number;
let suiteEmail: string;
let generatedMessageCounter = 0;

describe('Embedding Pipeline', () => {
  before(async function () {
    this.timeout(30_000);

    await quiesceAndRestore();

    const seededAccount = seedTestAccount({
      email: SUITE_EMAIL,
      displayName: SUITE_DISPLAY_NAME,
    });

    suiteAccountId = seededAccount.accountId;
    suiteEmail = seededAccount.email;

    restoreOllamaBaseUrl();
  });

  beforeEach(async function () {
    this.timeout(15_000);

    await ensureBuildStopped();
    resetPerTestState();
  });

  afterEach(async function () {
    this.timeout(15_000);

    await ensureBuildStopped();
  });

  it('returns not_started status when no build has started', async () => {
    const ollamaService = OllamaService.getInstance();
    ollamaService['currentEmbeddingModel'] = '';

    const response = await getEmbeddingStatus();

    expect(response.success).to.equal(true);
    expect(response.data!.indexStatus).to.equal('not_started');
    expect(response.data!.indexed).to.equal(0);
    expect(response.data!.total).to.equal(0);
  });

  it('builds the index through IPC and stores indexed emails in the vector DB', async function () {
    this.timeout(35_000);

    const insertedMessages = [
      injectAllMailFixture('plain-text'),
      injectAllMailFixture('html-email'),
      injectAllMailFixture('multipart-attachment'),
    ];

    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);
    expect(buildResponse.data!.started).to.equal(true);

    const progressArgs = await waitForEvent('embedding:progress', {
      timeout: 30_000,
      predicate: (args) => {
        const payload = args[0] as EmbeddingProgressPayload | undefined;
        return payload !== undefined && payload.indexed > 0;
      },
    });
    const progressPayload = progressArgs[0] as EmbeddingProgressPayload;

    expect(progressPayload.indexed).to.be.greaterThan(0);
    expect(progressPayload.total).to.equal(insertedMessages.length);

    await waitForEvent('embedding:complete', { timeout: 30_000 });

    const vectorDbService = VectorDbService.getInstance();
    expect(vectorDbService.countIndexedEmails(suiteAccountId)).to.equal(insertedMessages.length);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(insertedMessages.length);

    for (const message of insertedMessages) {
      expect(getDatabase().getEmailByXGmMsgId(suiteAccountId, message.xGmMsgId)).to.not.equal(null);
    }
  });

  it('returns to idle without indexing anything when no active accounts exist', async function () {
    this.timeout(20_000);

    try {
      await quiesceAndRestore();
      TestEventBus.getInstance().clear();
      restoreOllamaBaseUrl();

      await configureEmbeddingModel(4);

      const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;

      expect(buildResponse.success).to.equal(true);
      expect(buildResponse.data!.started).to.equal(true);

      const statusAfterBuild = await waitForNonBuildingStatus(5_000);

      expect(statusAfterBuild.indexStatus).to.equal('not_started');
      expect(statusAfterBuild.indexed).to.equal(0);
      expect(statusAfterBuild.total).to.equal(0);
      expect(TestEventBus.getInstance().getHistory('embedding:progress')).to.have.length(0);
      expect(VectorDbService.getInstance().countIndexedEmails()).to.equal(0);
    } finally {
      await reseedSuiteAccount();
    }
  });

  it('returns an error when no embedding model is configured', async () => {
    const ollamaService = OllamaService.getInstance();
    ollamaService['currentEmbeddingModel'] = '';

    const response = await callIpc('ai:build-index') as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AI_BUILD_INDEX_FAILED');
    expect(response.error!.message).to.include('No embedding model selected');
  });

  it('returns an error when the vector database is unavailable for a build', async () => {
    await configureEmbeddingModel(4);

    const vectorDbService = VectorDbService.getInstance() as VectorDbService & {
      vectorsAvailable: boolean;
    };
    const originalVectorsAvailable = vectorDbService.vectorsAvailable;
    vectorDbService.vectorsAvailable = false;

    try {
      const response = await callIpc('ai:build-index') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_BUILD_INDEX_FAILED');
      expect(response.error!.message).to.include('Vector DB is unavailable');
    } finally {
      vectorDbService.vectorsAvailable = originalVectorsAvailable;
    }
  });

  it('returns an error when the vector dimension is not configured for a build', async () => {
    await configureEmbeddingModel(4);

    const vectorDbService = VectorDbService.getInstance() as VectorDbService & {
      getVectorDimension: () => number | null;
    };
    const originalGetVectorDimension = vectorDbService.getVectorDimension;
    vectorDbService.getVectorDimension = (): number | null => {
      return null;
    };

    try {
      const response = await callIpc('ai:build-index') as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('AI_BUILD_INDEX_FAILED');
      expect(response.error!.message).to.include('Vector dimension not configured');
    } finally {
      vectorDbService.getVectorDimension = originalGetVectorDimension;
    }
  });

  it('returns an error when a build is already in progress', async function () {
    this.timeout(35_000);

    ollamaServer.setResponseDelay(200);
    injectAllMailFixture('plain-text');
    injectAllMailFixture('html-email');
    injectAllMailFixture('multipart-attachment');

    await configureEmbeddingModel(4);

    const firstBuildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    const secondBuildResponse = await callIpc('ai:build-index') as IpcResponse<unknown>;

    expect(firstBuildResponse.success).to.equal(true);
    expect(secondBuildResponse.success).to.equal(false);
    expect(secondBuildResponse.error!.code).to.equal('AI_BUILD_INDEX_FAILED');
    expect(secondBuildResponse.error!.message).to.include('already in progress');

    await waitForEvent('embedding:complete', { timeout: 30_000 });
  });

  it('completes gracefully when the dedicated IMAP crawl connection cannot authenticate', async function () {
    this.timeout(20_000);

    injectAllMailFixture('plain-text');

    await configureEmbeddingModel(4);
    imapStateInspector.injectCommandError('AUTHENTICATE', 'IMAP connection failed');

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;

    expect(buildResponse.success).to.equal(true);
    expect(buildResponse.data!.started).to.equal(true);

    await waitForEvent('embedding:complete', { timeout: 10_000 });

    const statusAfterBuild = await getEmbeddingStatus();

    expect(statusAfterBuild.success).to.equal(true);
    expect(statusAfterBuild.data!.indexStatus).to.equal('not_started');
    expect(statusAfterBuild.data!.indexed).to.equal(0);
    expect(statusAfterBuild.data!.total).to.equal(0);
    expect(VectorDbService.getInstance().countIndexedEmails(suiteAccountId)).to.equal(0);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(0);
    expect(TestEventBus.getInstance().getHistory('embedding:progress')).to.have.length(0);
  });

  it('cancels an active build and resets status back to idle', async function () {
    this.timeout(20_000);

    ollamaServer.setResponseDelay(300);
    injectAllMailFixture('plain-text');
    injectAllMailFixture('html-email');
    injectAllMailFixture('multipart-attachment');

    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForCondition(() => ollamaServer.getRequestsFor('/api/embed').length > 0, 5_000);

    const cancelResponse = await callIpc('ai:cancel-index') as IpcResponse<{ cancelled: boolean }>;
    expect(cancelResponse.success).to.equal(true);
    expect(cancelResponse.data!.cancelled).to.equal(true);

    const statusAfterCancel = await waitForNonBuildingStatus();

    expect(statusAfterCancel.indexStatus).to.equal('not_started');
    expect(statusAfterCancel.indexed).to.equal(0);
    expect(statusAfterCancel.total).to.equal(0);
  });

  it('rebuilds from scratch after clearing existing vectors', async function () {
    this.timeout(45_000);

    const keptMessage = injectAllMailFixture('plain-text');
    injectAllMailFixture('html-email');

    await configureEmbeddingModel(4);

    const initialBuildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(initialBuildResponse.success).to.equal(true);
    await waitForEvent('embedding:complete', { timeout: 30_000 });

    const vectorDbService = VectorDbService.getInstance();
    expect(vectorDbService.countIndexedEmails(suiteAccountId)).to.equal(2);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(2);

    resetImapOnly();
    imapStateInspector.getServer().addAllowedAccount(suiteEmail);
    imapStateInspector.injectMessage('[Gmail]/All Mail', emlFixtures['plain-text'].raw, {
      xGmMsgId: keptMessage.xGmMsgId,
      xGmThrid: keptMessage.xGmThrid,
      internalDate: DateTime.utc().plus({ minutes: 1 }).toISO()!,
      xGmLabels: ['\\All', '\\Inbox'],
    });

    const bus = TestEventBus.getInstance();
    const priorCompleteCount = bus.getHistory('embedding:complete').length;

    const rebuildResponse = await callIpc('ai:rebuild-index') as IpcResponse<{ started: boolean }>;
    expect(rebuildResponse.success).to.equal(true);
    expect(rebuildResponse.data!.started).to.equal(true);

    await waitForEvent('embedding:complete', {
      timeout: 30_000,
      predicate: () => TestEventBus.getInstance().getHistory('embedding:complete').length > priorCompleteCount,
    });

    expect(vectorDbService.countIndexedEmails(suiteAccountId)).to.equal(1);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(1);
  });

  it('treats a stale crawl cursor with an empty mailbox as already complete', async function () {
    this.timeout(20_000);

    getDatabase().upsertEmbeddingCrawlCursor(suiteAccountId, 999);
    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForEvent('embedding:complete', { timeout: 10_000 });

    expect(VectorDbService.getInstance().countIndexedEmails(suiteAccountId)).to.equal(0);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(0);
  });

  it('reindexes messages when the saved crawl cursor is ahead of all current UIDs', async function () {
    this.timeout(35_000);

    injectAllMailFixture('plain-text');
    getDatabase().upsertEmbeddingCrawlCursor(suiteAccountId, 999);
    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForEvent('embedding:complete', { timeout: 30_000 });

    expect(VectorDbService.getInstance().countIndexedEmails(suiteAccountId)).to.equal(1);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(1);
  });

  it('marks filtered All Mail messages as indexed sentinels without storing vectors', async function () {
    this.timeout(35_000);

    injectLabeledAllMailFixture('plain-text', ['\\All', '[Gmail]/Spam']);
    injectLabeledAllMailFixture('html-email', ['\\All', '[Gmail]/Drafts']);

    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForEvent('embedding:complete', { timeout: 30_000 });

    expect(VectorDbService.getInstance().countIndexedEmails(suiteAccountId)).to.equal(0);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(2);
  });

  it('completes a second build without re-embedding messages that are already indexed', async function () {
    this.timeout(40_000);

    injectAllMailFixture('plain-text');
    injectAllMailFixture('html-email');

    await configureEmbeddingModel(4);

    const firstBuildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(firstBuildResponse.success).to.equal(true);
    await waitForEvent('embedding:complete', { timeout: 30_000 });

    const priorProgressCount = TestEventBus.getInstance().getHistory('embedding:progress').length;
    const secondBuildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(secondBuildResponse.success).to.equal(true);
    await waitForEvent('embedding:complete', { timeout: 30_000 });

    expect(VectorDbService.getInstance().countIndexedEmails(suiteAccountId)).to.equal(2);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(2);
    expect(TestEventBus.getInstance().getHistory('embedding:progress').length).to.equal(priorProgressCount);
  });

  it('reports building status with live progress during an active build', async function () {
    this.timeout(35_000);

    ollamaServer.setResponseDelay(200);
    injectAllMailFixture('plain-text');
    injectAllMailFixture('html-email');
    injectAllMailFixture('multipart-attachment');

    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForEvent('embedding:progress', {
      timeout: 30_000,
      predicate: (args) => {
        const payload = args[0] as EmbeddingProgressPayload | undefined;
        return payload !== undefined && payload.indexed > 0;
      },
    });

    const statusResponse = await getEmbeddingStatus();

    expect(statusResponse.success).to.equal(true);
    expect(statusResponse.data!.indexStatus).to.equal('building');
    expect(statusResponse.data!.indexed).to.be.greaterThan(0);
    expect(statusResponse.data!.total).to.equal(3);
    expect(statusResponse.data!.indexed).to.be.lessThanOrEqual(statusResponse.data!.total);

    await waitForEvent('embedding:complete', { timeout: 30_000 });
  });

  it('emits an error after a later worker batch fails during a multi-batch build', async function () {
    this.timeout(120_000);

    for (let index = 0; index < 51; index += 1) {
      injectAllMailFixture('plain-text');
    }

    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForEvent('embedding:progress', {
      timeout: 30_000,
      predicate: (args) => {
        const payload = args[0] as EmbeddingProgressPayload | undefined;
        return payload !== undefined && payload.indexed >= 50 && payload.total === 51;
      },
    });

    ollamaServer.setError('embed', true);

    const errorArgs = await waitForEvent('embedding:error', { timeout: 95_000 });
    const errorPayload = errorArgs[0] as { message?: string };

    expect(errorPayload.message).to.be.a('string');
    expect(errorPayload.message).to.include('after 4 attempts');
    expect(VectorDbService.getInstance().countIndexedEmails(suiteAccountId)).to.equal(50);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(50);
  });

  it('emits an embedding:error event when Ollama embedding fails', async function () {
    this.timeout(100_000);

    injectAllMailFixture('plain-text');

    await configureEmbeddingModel(4);
    ollamaServer.setError('embed', true);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    const errorArgs = await waitForEvent('embedding:error', { timeout: 95_000 });
    const errorPayload = errorArgs[0] as { message?: string };

    expect(errorPayload.message).to.be.a('string');
    expect(errorPayload.message).to.include('Ollama embed');
    expect(VectorDbService.getInstance().countIndexedEmails(suiteAccountId)).to.equal(0);
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(0);
  });

  it('returns semantic search results after building the vector index', async function () {
    this.timeout(40_000);

    const insertedMessage = injectAllMailFixture('plain-text');

    ollamaServer.setEmbeddings([[1, 0, 0, 0]]);
    ollamaServer.setChatResponse(JSON.stringify({
      semanticQuery: 'embedding pipeline semantic query',
      filters: {},
    }));

    await configureEmbeddingModel(4);
    await configureChatModel();

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForEvent('embedding:complete', { timeout: 30_000 });

    const directVectorResults = VectorDbService.getInstance().search([1, 0, 0, 0], suiteAccountId, 10);

    expect(directVectorResults).to.not.deep.equal([]);
    expect(directVectorResults[0].xGmMsgId).to.equal(insertedMessage.xGmMsgId);
    expect(directVectorResults[0].similarity).to.be.greaterThan(0.99);

    const priorBatchCount = TestEventBus.getInstance().getHistory('ai:search:batch').length;

    const searchResponse = await callIpc(
      'ai:search',
      String(suiteAccountId),
      'embedding pipeline semantic query',
      undefined,
      'semantic',
    ) as IpcResponse<{ searchToken: string }>;

    expect(searchResponse.success).to.equal(true);

    const searchToken = searchResponse.data!.searchToken;
    const completePayload = await waitForSearchComplete(searchToken);
    const batchPayloads = getSearchBatchesSince(searchToken, priorBatchCount);

    expect(completePayload.status).to.equal('complete');
    expect(completePayload.totalResults).to.be.greaterThan(0);
    expect(batchPayloads.some((payload) => payload.msgIds.includes(insertedMessage.xGmMsgId))).to.equal(true);
  });

  it('counts indexed emails across all accounts when no account filter is provided', async function () {
    this.timeout(35_000);

    const secondAccount = seedTestAccount({
      email: 'embedding-pipeline-second@example.com',
      displayName: 'Embedding Pipeline Second User',
    });

    try {
      await configureEmbeddingModel(4);

      const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
      expect(buildResponse.success).to.equal(true);

      await waitForEvent('embedding:complete', { timeout: 30_000 });

      const vectorDbService = VectorDbService.getInstance();
      vectorDbService.deleteByAccountId(suiteAccountId);
      vectorDbService.insertChunks({
        accountId: suiteAccountId,
        xGmMsgId: 'embedding-suite-account-msg-001',
        chunks: [
          {
            chunkIndex: 0,
            chunkText: 'Suite account indexed email one',
            embedding: [1, 0, 0, 0],
          },
        ],
      });
      vectorDbService.insertChunks({
        accountId: suiteAccountId,
        xGmMsgId: 'embedding-suite-account-msg-002',
        chunks: [
          {
            chunkIndex: 0,
            chunkText: 'Suite account indexed email two',
            embedding: [0, 1, 0, 0],
          },
        ],
      });
      vectorDbService.insertChunks({
        accountId: secondAccount.accountId,
        xGmMsgId: 'embedding-second-account-msg-001',
        chunks: [
          {
            chunkIndex: 0,
            chunkText: 'Second account indexed email one',
            embedding: [1, 0, 0, 0],
          },
        ],
      });
      vectorDbService.insertChunks({
        accountId: secondAccount.accountId,
        xGmMsgId: 'embedding-second-account-msg-002',
        chunks: [
          {
            chunkIndex: 0,
            chunkText: 'Second account indexed email two',
            embedding: [0, 1, 0, 0],
          },
        ],
      });

      expect(vectorDbService.countIndexedEmails(suiteAccountId)).to.equal(2);
      expect(vectorDbService.countIndexedEmails(secondAccount.accountId)).to.equal(2);
      expect(vectorDbService.countIndexedEmails()).to.equal(4);
    } finally {
      VectorDbService.getInstance().deleteByAccountId(suiteAccountId);
      VectorDbService.getInstance().deleteByAccountId(secondAccount.accountId);
      await callIpc('auth:logout', String(secondAccount.accountId));
    }
  });

  it('returns no vector search results when the query dimension is invalid', async function () {
    this.timeout(10_000);

    await configureEmbeddingModel(4);

    const searchResults = VectorDbService.getInstance().search([1, 0, 0], suiteAccountId, 10);

    expect(searchResults).to.deep.equal([]);
  });

  it('returns no vector search results when vectors are unavailable', async function () {
    await configureEmbeddingModel(4);

    const vectorDbService = VectorDbService.getInstance() as VectorDbService & {
      vectorsAvailable: boolean;
    };
    const originalVectorsAvailable = vectorDbService.vectorsAvailable;
    vectorDbService.vectorsAvailable = false;

    try {
      const searchResults = VectorDbService.getInstance().search([1, 0, 0, 0], suiteAccountId, 10);

      expect(searchResults).to.deep.equal([]);
    } finally {
      vectorDbService.vectorsAvailable = originalVectorsAvailable;
    }
  });

  it('returns no vector search results when the vec0 table is unavailable', async function () {
    this.timeout(10_000);

    await configureEmbeddingModel(4);

    const vectorDbInternal = VectorDbService.getInstance() as unknown as {
      db: { exec: (sql: string) => void };
      configureModel: (model: string, dimension: number) => void;
    };

    vectorDbInternal.db.exec('DROP TABLE IF EXISTS email_embeddings');

    const searchResults = VectorDbService.getInstance().search([1, 0, 0, 0], suiteAccountId, 10);

    expect(searchResults).to.deep.equal([]);

    vectorDbInternal.configureModel('nomic-embed-text:latest', 4);
  });

  it('returns no vector search results when the KNN query throws unexpectedly', async function () {
    this.timeout(10_000);

    await configureEmbeddingModel(4);

    const vectorDbInternal = VectorDbService.getInstance() as unknown as {
      db: { prepare: (sql: string) => { all: (params?: unknown) => unknown } };
    };
    const originalPrepare = vectorDbInternal.db.prepare.bind(vectorDbInternal.db);

    try {
      vectorDbInternal.db.prepare = (sql: string) => {
        if (sql.includes('WHERE v.embedding MATCH :query')) {
          throw new Error('Forced vector search failure');
        }

        return originalPrepare(sql);
      };

      const searchResults = VectorDbService.getInstance().search([1, 0, 0, 0], suiteAccountId, 10);

      expect(searchResults).to.deep.equal([]);
    } finally {
      vectorDbInternal.db.prepare = originalPrepare;
    }
  });

  it('returns zero for global vector count when the metadata count query throws', async function () {
    this.timeout(10_000);

    await configureEmbeddingModel(4);

    const vectorDbInternal = VectorDbService.getInstance() as unknown as {
      db: { prepare: (sql: string) => { get: (params?: unknown) => unknown } };
    };
    const originalPrepare = vectorDbInternal.db.prepare.bind(vectorDbInternal.db);

    try {
      vectorDbInternal.db.prepare = (sql: string) => {
        if (sql.includes('SELECT COUNT(DISTINCT x_gm_msgid) AS count FROM embedding_metadata')) {
          throw new Error('Forced vector count failure');
        }

        return originalPrepare(sql);
      };

      expect(VectorDbService.getInstance().countIndexedEmails()).to.equal(0);
    } finally {
      vectorDbInternal.db.prepare = originalPrepare;
    }
  });

  it('deletes vectors for a single email without affecting other indexed emails', async function () {
    await configureEmbeddingModel(4);

    const vectorDbService = VectorDbService.getInstance();
    vectorDbService.insertChunks({
      accountId: suiteAccountId,
      xGmMsgId: 'vector-delete-target',
      chunks: [
        {
          chunkIndex: 0,
          chunkText: 'delete target',
          embedding: [1, 0, 0, 0],
        },
      ],
    });
    vectorDbService.insertChunks({
      accountId: suiteAccountId,
      xGmMsgId: 'vector-delete-keep',
      chunks: [
        {
          chunkIndex: 0,
          chunkText: 'keep target',
          embedding: [0, 1, 0, 0],
        },
      ],
    });

    expect(vectorDbService.countIndexedEmails(suiteAccountId)).to.equal(2);

    vectorDbService.deleteByXGmMsgId(suiteAccountId, 'vector-delete-target');

    expect(vectorDbService.countIndexedEmails(suiteAccountId)).to.equal(1);
    expect(vectorDbService.search([0, 1, 0, 0], suiteAccountId, 10).some((row) => row.xGmMsgId === 'vector-delete-keep')).to.equal(true);
  });

  it('treats deleteByXGmMsgId as a no-op when the email has no stored vectors', async function () {
    await configureEmbeddingModel(4);

    VectorDbService.getInstance().deleteByXGmMsgId(suiteAccountId, 'missing-vector-email');

    expect(VectorDbService.getInstance().countIndexedEmails(suiteAccountId)).to.equal(0);
  });
});

function restoreOllamaBaseUrl(): void {
  const ollamaService = OllamaService.getInstance();
  ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
  ollamaService.stopHealthChecks();
}

function resetImapOnly(): void {
  imapStateInspector.reset();
}

function resetPerTestState(): void {
  TestEventBus.getInstance().clear();
  resetImapOnly();
  imapStateInspector.getServer().addAllowedAccount(suiteEmail);

  ollamaServer.reset();
  restoreOllamaBaseUrl();

  const db = getDatabase();
  db.deleteEmailsByAccount(suiteAccountId);
  db.clearAllVectorIndexedEmails();
  db.clearAllEmbeddingCrawlProgress();

  VectorDbService.getInstance().deleteByAccountId(suiteAccountId);

  const ollamaService = OllamaService.getInstance();
  ollamaService['currentEmbeddingModel'] = '';
}

async function ensureBuildStopped(): Promise<void> {
  const embeddingService = EmbeddingService.getInstance();
  if (embeddingService.getBuildState() === 'building') {
    embeddingService.cancelBuild();
  }

  await embeddingService.resetForTesting();
}

async function configureEmbeddingModel(dimension: number): Promise<void> {
  const vectorDbService = VectorDbService.getInstance();
  expect(vectorDbService.vectorsAvailable).to.equal(true);

  ollamaServer.setEmbedDimension(dimension);

  const response = await callIpc('ai:set-embedding-model', 'nomic-embed-text:latest') as IpcResponse<{
    embeddingModel: string;
    vectorDimension: number;
  }>;

  expect(response.success).to.equal(true);
  expect(response.data!.embeddingModel).to.equal('nomic-embed-text:latest');
  expect(response.data!.vectorDimension).to.equal(dimension);
}

async function configureChatModel(): Promise<void> {
  const statusResponse = await callIpc('ai:get-status') as IpcResponse<{ connected: boolean }>;

  expect(statusResponse.success).to.equal(true);
  expect(statusResponse.data!.connected).to.equal(true);

  const modelResponse = await callIpc('ai:set-model', 'llama3.2:latest') as IpcResponse<{
    currentModel: string;
  }>;

  expect(modelResponse.success).to.equal(true);
  expect(modelResponse.data!.currentModel).to.equal('llama3.2:latest');
}

async function getEmbeddingStatus(): Promise<IpcResponse<EmbeddingStatusResponse>> {
  return callIpc('ai:get-embedding-status') as Promise<IpcResponse<EmbeddingStatusResponse>>;
}

async function waitForSearchComplete(
  searchToken: string,
  timeoutMilliseconds: number = 20_000,
): Promise<SearchCompletePayload> {
  const resultArgs = await waitForEvent('ai:search:complete', {
    timeout: timeoutMilliseconds,
    predicate: (args) => {
      const payload = args[0] as SearchCompletePayload | undefined;
      return payload !== undefined && payload.searchToken === searchToken;
    },
  });

  return resultArgs[0] as SearchCompletePayload;
}

function getSearchBatchesSince(searchToken: string, priorBatchCount: number): SearchBatchPayload[] {
  return TestEventBus.getInstance()
    .getHistory('ai:search:batch')
    .slice(priorBatchCount)
    .map((record) => record.args[0] as SearchBatchPayload)
    .filter((payload) => payload !== undefined && payload.searchToken === searchToken);
}

async function waitForNonBuildingStatus(timeoutMilliseconds: number = 15_000): Promise<EmbeddingStatusResponse> {
  const startMillis = DateTime.utc().toMillis();

  while (DateTime.utc().toMillis() - startMillis < timeoutMilliseconds) {
    const response = await getEmbeddingStatus();
    if (response.success && response.data!.indexStatus !== 'building') {
      return response.data!;
    }
    await sleep(100);
  }

  throw new Error(`Timed out after ${timeoutMilliseconds}ms waiting for embedding build to stop`);
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMilliseconds: number = 5_000,
  pollIntervalMilliseconds: number = 25,
): Promise<void> {
  const startMillis = DateTime.utc().toMillis();

  while (DateTime.utc().toMillis() - startMillis < timeoutMilliseconds) {
    if (predicate()) {
      return;
    }

    await sleep(pollIntervalMilliseconds);
  }

  throw new Error(`Timed out after ${timeoutMilliseconds}ms waiting for condition`);
}

async function reseedSuiteAccount(): Promise<void> {
  await quiesceAndRestore();

  const seededAccount = seedTestAccount({
    email: SUITE_EMAIL,
    displayName: SUITE_DISPLAY_NAME,
  });

  suiteAccountId = seededAccount.accountId;
  suiteEmail = seededAccount.email;

  restoreOllamaBaseUrl();
  TestEventBus.getInstance().clear();
}

function injectAllMailFixture(fixtureName: MessageFixtureName): { xGmMsgId: string; xGmThrid: string } {
  generatedMessageCounter += 1;

  const fixture = emlFixtures[fixtureName];
  const xGmMsgId = `910000000000${generatedMessageCounter}`;
  const xGmThrid = `920000000000${generatedMessageCounter}`;

  return injectAllMailRaw(fixture.raw, xGmMsgId, xGmThrid, ['\\All', '\\Inbox']);
}

function injectLabeledAllMailFixture(
  fixtureName: MessageFixtureName,
  labels: string[],
): { xGmMsgId: string; xGmThrid: string } {
  generatedMessageCounter += 1;

  const fixture = emlFixtures[fixtureName];
  const xGmMsgId = `910000000000${generatedMessageCounter}`;
  const xGmThrid = `920000000000${generatedMessageCounter}`;

  return injectAllMailRaw(fixture.raw, xGmMsgId, xGmThrid, labels);
}

function injectAllMailRaw(
  rawMessage: Buffer,
  xGmMsgId: string,
  xGmThrid: string,
  labels: string[],
): { xGmMsgId: string; xGmThrid: string } {

  imapStateInspector.injectMessage('[Gmail]/All Mail', rawMessage, {
    xGmMsgId,
    xGmThrid,
    internalDate: DateTime.utc().plus({ minutes: generatedMessageCounter }).toISO()!,
    xGmLabels: labels,
  });

  return { xGmMsgId, xGmThrid };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
