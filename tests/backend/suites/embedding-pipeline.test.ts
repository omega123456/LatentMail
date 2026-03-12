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

let suiteAccountId: number;
let suiteEmail: string;
let generatedMessageCounter = 0;

describe('Embedding Pipeline', () => {
  before(async function () {
    this.timeout(30_000);

    await quiesceAndRestore();

    const seededAccount = seedTestAccount({
      email: 'embedding-pipeline@example.com',
      displayName: 'Embedding Pipeline User',
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
    await sleep(1_000);
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

  it('returns an error when no embedding model is configured', async () => {
    const ollamaService = OllamaService.getInstance();
    ollamaService['currentEmbeddingModel'] = '';

    const response = await callIpc('ai:build-index') as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('AI_BUILD_INDEX_FAILED');
    expect(response.error!.message).to.include('No embedding model selected');
  });

  it('returns an error when a build is already in progress', async function () {
    this.timeout(35_000);

    ollamaServer.setResponseDelay(1_500);
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

  it('cancels an active build and resets status back to idle', async function () {
    this.timeout(20_000);

    ollamaServer.setResponseDelay(2_500);
    injectAllMailFixture('plain-text');
    injectAllMailFixture('html-email');
    injectAllMailFixture('multipart-attachment');

    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await sleep(100);

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

  it('reports building status with live progress during an active build', async function () {
    this.timeout(35_000);

    ollamaServer.setResponseDelay(1_500);
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
    await waitForNonBuildingStatus();
  }
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

async function getEmbeddingStatus(): Promise<IpcResponse<EmbeddingStatusResponse>> {
  return callIpc('ai:get-embedding-status') as Promise<IpcResponse<EmbeddingStatusResponse>>;
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

function injectAllMailFixture(fixtureName: MessageFixtureName): { xGmMsgId: string; xGmThrid: string } {
  generatedMessageCounter += 1;

  const fixture = emlFixtures[fixtureName];
  const xGmMsgId = `910000000000${generatedMessageCounter}`;
  const xGmThrid = `920000000000${generatedMessageCounter}`;

  imapStateInspector.injectMessage('[Gmail]/All Mail', fixture.raw, {
    xGmMsgId,
    xGmThrid,
    internalDate: DateTime.utc().plus({ minutes: generatedMessageCounter }).toISO()!,
    xGmLabels: ['\\All', '\\Inbox'],
  });

  return { xGmMsgId, xGmThrid };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
