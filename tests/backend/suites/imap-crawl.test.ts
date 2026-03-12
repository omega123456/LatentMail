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
import { ImapCrawlService } from '../../../electron/services/imap-crawl-service';

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

let suiteAccountId: number;
let suiteEmail: string;
let generatedMessageCounter = 0;

describe('IMAP Crawl via Embedding Pipeline', () => {
  before(async function () {
    this.timeout(30_000);

    await quiesceAndRestore();

    const seededAccount = seedTestAccount({
      email: 'imap-crawl@example.com',
      displayName: 'IMAP Crawl User',
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

  it('connects to All Mail, builds the index, and disconnects afterward', async function () {
    this.timeout(35_000);

    injectAllMailFixture('plain-text');
    injectAllMailFixture('html-email');

    await configureEmbeddingModel(4);

    const crawlService = ImapCrawlService.getInstance();
    expect(crawlService.isConnected(String(suiteAccountId))).to.equal(false);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForEvent('embedding:progress', {
      timeout: 30_000,
      predicate: () => crawlService.isConnected(String(suiteAccountId)),
    });

    expect(crawlService.isConnected(String(suiteAccountId))).to.equal(true);

    await waitForEvent('embedding:complete', { timeout: 30_000 });

    expect(crawlService.isConnected(String(suiteAccountId))).to.equal(false);
  });

  it('indexes the exact All Mail messages injected for the build', async function () {
    this.timeout(35_000);

    const firstMessage = injectAllMailFixture('plain-text');
    const secondMessage = injectAllMailFixture('html-email');
    const thirdMessage = injectAllMailFixture('multipart-attachment');

    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    await waitForEvent('embedding:complete', { timeout: 30_000 });

    const vectorDbService = VectorDbService.getInstance();
    expect(vectorDbService.countIndexedEmails(suiteAccountId)).to.equal(3);

    const db = getDatabase();
    const indexedMessageIds = db.getIndexedMsgIds(suiteAccountId);

    expect(indexedMessageIds.has(firstMessage.xGmMsgId)).to.equal(true);
    expect(indexedMessageIds.has(secondMessage.xGmMsgId)).to.equal(true);
    expect(indexedMessageIds.has(thirdMessage.xGmMsgId)).to.equal(true);
  });

  it('processes the expected number of All Mail UIDs discovered by the crawl', async function () {
    this.timeout(35_000);

    injectAllMailFixture('plain-text');
    injectAllMailFixture('html-email');
    injectAllMailFixture('multipart-attachment');
    injectAllMailFixture('inline-images');

    await configureEmbeddingModel(4);

    const buildResponse = await callIpc('ai:build-index') as IpcResponse<{ started: boolean }>;
    expect(buildResponse.success).to.equal(true);

    const progressArgs = await waitForEvent('embedding:progress', {
      timeout: 30_000,
      predicate: (args) => {
        const payload = args[0] as { indexed?: number; total?: number } | undefined;
        return payload !== undefined && payload.total === 4;
      },
    });

    const progressPayload = progressArgs[0] as { indexed: number; total: number; percent: number };
    expect(progressPayload.total).to.equal(4);
    expect(progressPayload.indexed).to.be.greaterThan(0);

    await waitForEvent('embedding:complete', { timeout: 30_000 });
    expect(getDatabase().countVectorIndexedEmails(suiteAccountId)).to.equal(4);
  });
});

function restoreOllamaBaseUrl(): void {
  const ollamaService = OllamaService.getInstance();
  ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
  ollamaService.stopHealthChecks();
}

function resetPerTestState(): void {
  TestEventBus.getInstance().clear();
  imapStateInspector.reset();
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
    await waitForNonBuildingState();
  }
}

async function waitForNonBuildingState(timeoutMilliseconds: number = 15_000): Promise<void> {
  const startMillis = DateTime.utc().toMillis();
  while (DateTime.utc().toMillis() - startMillis < timeoutMilliseconds) {
    const status = await callIpc('ai:get-embedding-status') as IpcResponse<{
      indexStatus: string;
    }>;

    if (status.success && status.data!.indexStatus !== 'building') {
      return;
    }

    await sleep(100);
  }

  throw new Error(`Timed out after ${timeoutMilliseconds}ms waiting for build to stop`);
}

async function configureEmbeddingModel(dimension: number): Promise<void> {
  ollamaServer.setEmbedDimension(dimension);

  const response = await callIpc('ai:set-embedding-model', 'nomic-embed-text:latest') as IpcResponse<{
    embeddingModel: string;
    vectorDimension: number;
  }>;

  expect(response.success).to.equal(true);
  expect(response.data!.vectorDimension).to.equal(dimension);
}

function injectAllMailFixture(fixtureName: MessageFixtureName): { xGmMsgId: string; xGmThrid: string } {
  generatedMessageCounter += 1;

  const fixture = emlFixtures[fixtureName];
  const xGmMsgId = `930000000000${generatedMessageCounter}`;
  const xGmThrid = `940000000000${generatedMessageCounter}`;

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
