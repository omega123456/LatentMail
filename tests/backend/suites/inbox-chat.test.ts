import { expect } from 'chai';
import { DateTime } from 'luxon';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  getDatabase,
  seedTestAccount,
  triggerSyncAndWait,
  waitForEvent,
} from '../infrastructure/test-helpers';
import { imapStateInspector, ollamaServer } from '../test-main';
import { emlFixtures, MessageFixtureName } from '../fixtures/index';
import { TestEventBus } from '../infrastructure/test-event-bus';
import { OllamaService } from '../../../electron/services/ollama-service';
import { VectorDbService } from '../../../electron/services/vector-db-service';
import { SourceEmail } from '../../../electron/services/inbox-chat-service';

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface ChatRequestPayload {
  question: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
  accountId: number;
}

interface ChatDonePayload {
  requestId: string;
  success: boolean;
  cancelled: boolean;
  error?: string;
}

interface ChatSourcesPayload {
  requestId: string;
  sources: SourceEmail[];
}

interface ChatStreamPayload {
  requestId: string;
  token: string;
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

interface SyncedEmailRecord {
  fixtureName: MessageFixtureName;
  xGmMsgId: string;
  xGmThrid: string;
}

let suiteAccountId: number;
let suiteEmail: string;
let generatedMessageCounter = 0;

describe('Inbox Chat Pipeline', () => {
  before(async function () {
    this.timeout(35_000);

    await quiesceAndRestore();

    const seededAccount = seedTestAccount({
      email: 'inbox-chat@example.com',
      displayName: 'Inbox Chat User',
    });

    suiteAccountId = seededAccount.accountId;
    suiteEmail = seededAccount.email;

    restoreOllamaBaseUrl();
  });

  beforeEach(() => {
    resetPerTestState();
  });

  it('streams a happy-path chat answer and emits cited source emails', async function () {
    this.timeout(30_000);

    await configureChatModels();
    const syncedEmails = await syncInboxFixtures(['plain-text', 'html-email', 'multipart-attachment']);

    insertSemanticChunk(syncedEmails[0].xGmMsgId, 'Budget planning decisions from the kickoff thread.', [1, 0, 0, 0]);
    insertSemanticChunk(syncedEmails[1].xGmMsgId, 'Design review updates and action items for the release.', [1, 0, 0, 0]);
    insertSemanticChunk(syncedEmails[2].xGmMsgId, 'Latest project update with deadlines and owners.', [1, 0, 0, 0]);

    ollamaServer.setChatResponse(JSON.stringify([
      { query: 'completely unrelated alpha', dateOrder: 'desc' },
      { query: 'completely unrelated beta', dateOrder: 'desc' },
      { query: 'completely unrelated gamma', dateOrder: 'desc' },
      { query: 'completely unrelated delta', dateOrder: 'desc' },
      { query: 'recent project updates', dateOrder: 'desc' },
    ]));
    ollamaServer.setEmbeddings([
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [-1, 0, 0],
      [1, 0, 0, 0],
    ]);
    ollamaServer.setChatStreamChunks([
      'The newest project update is captured in the latest synced email [1]. ',
      'A related earlier design review appears in [2].',
    ]);

    const requestId = await startChat({
      question: 'Which recent emails mention project updates?',
      conversationHistory: [],
      accountId: suiteAccountId,
    });

    const sourcesPayload = await waitForChatSources(requestId);
    const donePayload = await waitForChatDone(requestId);
    const streamedText = getChatStreamText(requestId);

    expect(streamedText).to.include('latest synced email [1]');
    expect(streamedText).to.include('design review appears in [2]');
    expect(donePayload.success).to.equal(true);
    expect(donePayload.cancelled).to.equal(false);
    expect(sourcesPayload.sources.map((source) => source.xGmMsgId)).to.deep.equal([
      syncedEmails[2].xGmMsgId,
      syncedEmails[1].xGmMsgId,
    ]);
    expect(sourcesPayload.sources.map((source) => source.citationIndex)).to.deep.equal([1, 2]);
  });

  it('falls back to the raw query when rewrite fails and still completes the chat', async function () {
    this.timeout(30_000);

    await configureChatModels();
    const syncedEmails = await syncInboxFixtures(['plain-text']);

    insertSemanticChunk(syncedEmails[0].xGmMsgId, 'Roadmap feedback from Acme with requested follow-up.', [1, 0, 0, 0]);

    ollamaServer.setEmbeddings([[1, 0, 0, 0]]);
    ollamaServer.setError('chat', true);

    const rawQuestion = 'Where did Acme ask about the roadmap?';
    const priorEmbedRequestCount = ollamaServer.getRequestsFor('/api/embed').length;

    const requestId = await startChat({
      question: rawQuestion,
      conversationHistory: [],
      accountId: suiteAccountId,
    });

    await waitForCapturedRequestCount('/api/embed', priorEmbedRequestCount + 1, 10_000);

    ollamaServer.setError('chat', false);
    ollamaServer.setChatResponse('{"relevant":true}');
    ollamaServer.setChatStreamChunks(['The Acme roadmap request is summarized here [1].']);

    const sourcesPayload = await waitForChatSources(requestId);
    const donePayload = await waitForChatDone(requestId);
    const embedRequest = ollamaServer.getRequestsFor('/api/embed')[priorEmbedRequestCount];

    expect(donePayload.cancelled).to.equal(false);
    expect(donePayload.success).to.be.a('boolean');
    expect(sourcesPayload.sources).to.be.an('array');
    expect(embedRequest).to.not.equal(undefined);
    expect(embedRequest!.body['input']).to.deep.equal([rawQuestion]);
  });

  it('returns the no-matching-emails fallback when vector search yields zero chunks', async function () {
    this.timeout(30_000);

    await configureChatModels();
    await syncInboxFixtures(['plain-text']);

    ollamaServer.setChatResponse(JSON.stringify([
      { query: 'nothing one', dateOrder: 'desc' },
      { query: 'nothing two', dateOrder: 'desc' },
      { query: 'nothing three', dateOrder: 'desc' },
      { query: 'nothing four', dateOrder: 'desc' },
      { query: 'nothing five', dateOrder: 'desc' },
    ]));
    ollamaServer.setEmbeddings([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
      [1, 1, 0],
      [-1, 0, 0],
    ]);

    const requestId = await startChat({
      question: 'Do I have any messages about a board memo?',
      conversationHistory: [],
      accountId: suiteAccountId,
    });

    const sourcesPayload = await waitForChatSources(requestId);
    const donePayload = await waitForChatDone(requestId);
    const streamedText = getChatStreamText(requestId);

    expect(streamedText).to.include("I couldn't find any emails that match what you're looking for");
    expect(sourcesPayload.sources).to.deep.equal([]);
    expect(donePayload.success).to.equal(true);
    expect(donePayload.cancelled).to.equal(false);
  });

  it('cancels an active chat after streaming starts and emits cancelled=true', async function () {
    this.timeout(30_000);

    await configureChatModels();
    const syncedEmails = await syncInboxFixtures(['plain-text']);

    insertSemanticChunk(syncedEmails[0].xGmMsgId, 'Streaming cancellation target content.', [1, 0, 0, 0]);

    ollamaServer.setChatResponse(JSON.stringify([
      { query: 'cancel alpha', dateOrder: 'desc' },
      { query: 'cancel beta', dateOrder: 'desc' },
      { query: 'cancel gamma', dateOrder: 'desc' },
      { query: 'cancel delta', dateOrder: 'desc' },
      { query: 'cancel target', dateOrder: 'desc' },
    ]));
    ollamaServer.setEmbeddings([
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [-1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    ollamaServer.setChatStreamChunks(Array.from({ length: 80 }, (_value, index) => `token-${index} `));

    const requestId = await startChat({
      question: 'Tell me about the cancellation test email.',
      conversationHistory: [],
      accountId: suiteAccountId,
    });

    await waitForEvent('ai:chat:stream', {
      timeout: 20_000,
      predicate: (args) => {
        const payload = args[0] as ChatStreamPayload | undefined;
        return payload != null && payload.requestId === requestId;
      },
    });

    const cancelResponse = await callIpc('ai:chat:cancel', { requestId }) as IpcResponse<{ cancelled: boolean }>;
    expect(cancelResponse.success).to.equal(true);
    expect(cancelResponse.data!.cancelled).to.equal(true);

    const sourcesPayload = await waitForChatSources(requestId);
    const donePayload = await waitForChatDone(requestId);

    expect(sourcesPayload.sources).to.deep.equal([]);
    expect(donePayload.success).to.equal(true);
    expect(donePayload.cancelled).to.equal(true);
    expect(getChatTokenCount(requestId)).to.be.lessThan(80);
  });

  it('passes prior conversation history into follow-up chat requests', async function () {
    this.timeout(35_000);

    await configureChatModels();
    const syncedEmails = await syncInboxFixtures(['plain-text']);

    insertSemanticChunk(syncedEmails[0].xGmMsgId, 'Conversation follow-up context from the synced email.', [1, 0, 0, 0]);

    ollamaServer.setChatResponse(JSON.stringify([
      { query: 'history alpha', dateOrder: 'desc' },
      { query: 'history beta', dateOrder: 'desc' },
      { query: 'history gamma', dateOrder: 'desc' },
      { query: 'history delta', dateOrder: 'desc' },
      { query: 'history final', dateOrder: 'desc' },
    ]));
    ollamaServer.setEmbeddings([
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [-1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    ollamaServer.setChatStreamChunks(['The original answer referenced the synced email [1].']);

    const firstQuestion = 'What did the original email cover?';
    const firstRequestId = await startChat({
      question: firstQuestion,
      conversationHistory: [],
      accountId: suiteAccountId,
    });

    await waitForChatDone(firstRequestId);

    ollamaServer.reset();
    restoreOllamaBaseUrl();
    ollamaServer.setChatResponse(JSON.stringify([
      { query: 'follow-up alpha', dateOrder: 'desc' },
      { query: 'follow-up beta', dateOrder: 'desc' },
      { query: 'follow-up gamma', dateOrder: 'desc' },
      { query: 'follow-up delta', dateOrder: 'desc' },
      { query: 'follow-up final', dateOrder: 'desc' },
    ]));
    ollamaServer.setEmbeddings([
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [-1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    ollamaServer.setChatStreamChunks(['The follow-up still uses the earlier context [1].']);

    const conversationHistory = [
      { role: 'user' as const, content: firstQuestion },
      { role: 'assistant' as const, content: 'The original answer referenced the synced email [1].' },
    ];

    const secondQuestion = 'And what follow-up action did it request?';
    const secondRequestId = await startChat({
      question: secondQuestion,
      conversationHistory,
      accountId: suiteAccountId,
    });

    await waitForChatDone(secondRequestId);

    const chatRequests = ollamaServer.getRequestsFor('/api/chat');
    expect(chatRequests.length).to.be.greaterThan(1);

    const rewriteRequest = chatRequests[0]!;
    const rewriteMessages = rewriteRequest.body['messages'] as Array<Record<string, unknown>>;
    const rewriteUserMessage = String(rewriteMessages[1]!['content']);

    expect(rewriteUserMessage).to.include(`User: ${firstQuestion}`);
    expect(rewriteUserMessage).to.include('Assistant: The original answer referenced the synced email [1].');
    expect(rewriteUserMessage).to.include(`New question: ${secondQuestion}`);

    const streamRequest = chatRequests.find((request) => request.body['stream'] === true);
    expect(streamRequest).to.not.equal(undefined);

    const streamMessages = streamRequest!.body['messages'] as Array<Record<string, unknown>>;
    expect(streamMessages.map((message) => String(message['content']))).to.include(firstQuestion);
    expect(streamMessages.map((message) => String(message['content']))).to.include('The original answer referenced the synced email [1].');
  });

  it('parses grouped citation markers like [2,3] and deduplicates repeated citations', async function () {
    this.timeout(30_000);

    const citationAccount = seedTestAccount({
      email: `inbox-chat-citations-${Date.now()}@example.com`,
      displayName: 'Inbox Chat Citation User',
    });

    try {
      await configureChatModels();
      const syncedEmails = await syncInboxFixtures(
        ['plain-text', 'html-email', 'multipart-attachment'],
        citationAccount.accountId,
        citationAccount.email,
      );

      insertSemanticChunk(syncedEmails[0].xGmMsgId, 'Oldest context chunk.', [0.9, 0.1, 0, 0], citationAccount.accountId);
      insertSemanticChunk(syncedEmails[1].xGmMsgId, 'Middle context chunk.', [0.95, 0.05, 0, 0], citationAccount.accountId);
      insertSemanticChunk(syncedEmails[2].xGmMsgId, 'Newest context chunk.', [1, 0, 0, 0], citationAccount.accountId);

      const vectorResults = VectorDbService.getInstance().search([1, 0, 0, 0], citationAccount.accountId, 10);
      expect(vectorResults).to.have.length.at.least(3);

      ollamaServer.setChatResponse(JSON.stringify([
        { query: 'citation alpha', dateOrder: 'desc' },
        { query: 'citation beta', dateOrder: 'desc' },
        { query: 'citation gamma', dateOrder: 'desc' },
        { query: 'citation delta', dateOrder: 'desc' },
        { query: 'citation target', dateOrder: 'desc' },
      ]));
      ollamaServer.setEmbeddings([
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
        [-1, 0, 0, 0],
        [1, 0, 0, 0],
      ]);
      ollamaServer.setChatStreamChunks(['The detailed evidence starts in [1] and is expanded in [2,3], while [2] reinforces it.']);

      const requestId = await startChat({
        question: 'Show me the cited evidence for the latest project items.',
        conversationHistory: [],
        accountId: citationAccount.accountId,
      });

      const sourcesPayload = await waitForChatSources(requestId);
      const donePayload = await waitForChatDone(requestId);

      expect(donePayload.success).to.equal(true);
      expect(sourcesPayload.sources.map((source) => ({ xGmMsgId: source.xGmMsgId, citationIndex: source.citationIndex }))).to.deep.equal([
        { xGmMsgId: syncedEmails[2].xGmMsgId, citationIndex: 1 },
        { xGmMsgId: syncedEmails[1].xGmMsgId, citationIndex: 2 },
        { xGmMsgId: syncedEmails[0].xGmMsgId, citationIndex: 3 },
      ]);
    } finally {
      VectorDbService.getInstance().deleteByAccountId(citationAccount.accountId);
      await callIpc('auth:logout', String(citationAccount.accountId));
    }
  });

  it('ignores out-of-bounds citations like [99] while preserving valid sources', async function () {
    this.timeout(30_000);

    await configureChatModels();
    const syncedEmails = await syncInboxFixtures(['plain-text', 'html-email']);

    insertSemanticChunk(syncedEmails[0].xGmMsgId, 'Older valid source chunk.', [1, 0, 0, 0]);
    insertSemanticChunk(syncedEmails[1].xGmMsgId, 'Newer valid source chunk.', [1, 0, 0, 0]);

    ollamaServer.setChatResponse(JSON.stringify([
      { query: 'bounds alpha', dateOrder: 'desc' },
      { query: 'bounds beta', dateOrder: 'desc' },
      { query: 'bounds gamma', dateOrder: 'desc' },
      { query: 'bounds delta', dateOrder: 'desc' },
      { query: 'bounds final', dateOrder: 'desc' },
    ]));
    ollamaServer.setEmbeddings([
      [0, 1, 0, 0],
      [0, 0, 1, 0],
      [0, 0, 0, 1],
      [-1, 0, 0, 0],
      [1, 0, 0, 0],
    ]);
    ollamaServer.setChatStreamChunks(['Ignore missing [99], but the real answer is supported by [1].']);

    const requestId = await startChat({
      question: 'Which email contains the supported answer?',
      conversationHistory: [],
      accountId: suiteAccountId,
    });

    const sourcesPayload = await waitForChatSources(requestId);
    const donePayload = await waitForChatDone(requestId);

    expect(donePayload.success).to.equal(true);
    expect(sourcesPayload.sources).to.have.length(1);
    expect(sourcesPayload.sources[0]!.xGmMsgId).to.equal(syncedEmails[1].xGmMsgId);
    expect(sourcesPayload.sources[0]!.citationIndex).to.equal(1);
  });

  it('navigates to a valid source xGmMsgId through ai:chat:navigate', async function () {
    this.timeout(25_000);

    const syncedEmails = await syncInboxFixtures(['plain-text']);

    const eventBus = TestEventBus.getInstance();
    const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

    const response = await callIpc('ai:chat:navigate', {
      accountId: suiteAccountId,
      xGmMsgId: syncedEmails[0].xGmMsgId,
    }) as IpcResponse<{ searchToken: string }>;

    expect(response.success).to.equal(true);
    expect(response.data!.searchToken).to.be.a('string');

    const completePayload = await waitForSearchComplete(response.data!.searchToken);
    const batches = getSearchBatchesSince(response.data!.searchToken, priorBatchCount);
    const localMsgIds = batches
      .filter((batch) => batch.phase === 'local')
      .flatMap((batch) => batch.msgIds);

    expect(completePayload.status).to.equal('complete');
    expect(completePayload.totalResults).to.equal(1);
    expect(localMsgIds).to.include(syncedEmails[0].xGmMsgId);
  });

  it('handles navigation to a non-existent source xGmMsgId gracefully', async function () {
    this.timeout(25_000);

    await syncInboxFixtures(['plain-text']);

    const eventBus = TestEventBus.getInstance();
    const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

    const response = await callIpc('ai:chat:navigate', {
      accountId: suiteAccountId,
      xGmMsgId: 'missing-source-msgid-999',
    }) as IpcResponse<{ searchToken: string }>;

    expect(response.success).to.equal(true);

    const completePayload = await waitForSearchComplete(response.data!.searchToken);
    const batches = getSearchBatchesSince(response.data!.searchToken, priorBatchCount);
    const allBatchMsgIds = batches.flatMap((batch) => batch.msgIds);

    expect(completePayload.status).to.equal('complete');
    expect(completePayload.totalResults).to.equal(0);
    expect(allBatchMsgIds).to.deep.equal([]);
  });

  it('returns the fallback no-results response when relevance checks say the chunks are not relevant', async function () {
    this.timeout(30_000);

    await configureChatModels();
    const syncedEmails = await syncInboxFixtures(['plain-text']);

    insertSemanticChunk(syncedEmails[0].xGmMsgId, 'Potentially relevant chunk that relevance should reject.', [1, 0, 0, 0]);

    ollamaServer.setChatResponse(JSON.stringify({
      relevant: false,
      queries: [
        { query: 'relevance alpha', dateOrder: 'desc' },
        { query: 'relevance beta', dateOrder: 'desc' },
        { query: 'relevance gamma', dateOrder: 'desc' },
        { query: 'relevance delta', dateOrder: 'desc' },
        { query: 'relevance epsilon', dateOrder: 'desc' },
      ],
    }));
    ollamaServer.setEmbeddings([
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [1, 0, 0, 0],
      [0, 1, 0],
    ]);

    const requestId = await startChat({
      question: 'Find a relevant email about a rejected topic.',
      conversationHistory: [],
      accountId: suiteAccountId,
    });
    ollamaServer.setChatStreamChunks(['This should never stream.']);

    const sourcesPayload = await waitForChatSources(requestId);
    const donePayload = await waitForChatDone(requestId);
    const streamedText = getChatStreamText(requestId);
    const chatRequests = ollamaServer.getRequestsFor('/api/chat');
    const streamingRequests = chatRequests.filter((request) => request.body['stream'] === true);

    expect(streamedText).to.include("I couldn't find any emails that match what you're looking for");
    expect(sourcesPayload.sources).to.deep.equal([]);
    expect(donePayload.success).to.equal(true);
    expect(donePayload.cancelled).to.equal(false);
    expect(streamingRequests).to.deep.equal([]);
  });
});

function resetPerTestState(): void {
  TestEventBus.getInstance().clear();

  imapStateInspector.reset();
  imapStateInspector.getServer().addAllowedAccount(suiteEmail);

  const databaseService = getDatabase();
  databaseService.deleteEmailsByAccount(suiteAccountId);
  databaseService.clearAllVectorIndexedEmails();
  databaseService.clearAllEmbeddingCrawlProgress();

  const vectorDbService = VectorDbService.getInstance();
  vectorDbService.deleteByAccountId(suiteAccountId);

  const ollamaService = OllamaService.getInstance();
  ollamaService['currentModel'] = '';
  ollamaService['currentEmbeddingModel'] = '';

  ollamaServer.reset();
  restoreOllamaBaseUrl();
}

function restoreOllamaBaseUrl(): void {
  const ollamaService = OllamaService.getInstance();
  ollamaService['baseUrl'] = ollamaServer.getBaseUrl();
  ollamaService.stopHealthChecks();
}

async function configureChatModels(): Promise<void> {
  const statusResponse = await callIpc('ai:set-url', ollamaServer.getBaseUrl()) as IpcResponse<{ connected: boolean }>;
  expect(statusResponse.success).to.equal(true);
  expect(statusResponse.data!.connected).to.equal(true);

  const modelResponse = await callIpc('ai:set-model', 'llama3.2:latest') as IpcResponse<{ currentModel: string }>;
  expect(modelResponse.success).to.equal(true);
  expect(modelResponse.data!.currentModel).to.equal('llama3.2:latest');

  ollamaServer.setEmbedDimension(4);
  const embeddingModelResponse = await callIpc('ai:set-embedding-model', 'nomic-embed-text:latest') as IpcResponse<{
    embeddingModel: string;
    vectorDimension: number;
  }>;

  expect(embeddingModelResponse.success).to.equal(true);
  expect(embeddingModelResponse.data!.embeddingModel).to.equal('nomic-embed-text:latest');
  expect(embeddingModelResponse.data!.vectorDimension).to.equal(4);

  VectorDbService.getInstance().clearAllAndReconfigure(
    embeddingModelResponse.data!.embeddingModel,
    embeddingModelResponse.data!.vectorDimension,
  );
}

async function syncInboxFixtures(
  fixtureNames: MessageFixtureName[],
  accountId: number = suiteAccountId,
  accountEmail: string = suiteEmail,
): Promise<SyncedEmailRecord[]> {
  const syncedEmails: SyncedEmailRecord[] = [];

  for (const fixtureName of fixtureNames) {
    generatedMessageCounter += 1;

    const fixture = emlFixtures[fixtureName];
    const xGmMsgId = `930000000000${generatedMessageCounter}`;
    const xGmThrid = `940000000000${generatedMessageCounter}`;
    const internalDate = DateTime.utc().plus({ minutes: generatedMessageCounter }).toISO()!;

    imapStateInspector.getServer().addAllowedAccount(accountEmail);

    imapStateInspector.injectMessage('[Gmail]/All Mail', fixture.raw, {
      xGmMsgId,
      xGmThrid,
      internalDate,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });

    imapStateInspector.injectMessage('INBOX', fixture.raw, {
      xGmMsgId,
      xGmThrid,
      internalDate,
      xGmLabels: ['\\Inbox'],
    });

    syncedEmails.push({ fixtureName, xGmMsgId, xGmThrid });
  }

  await triggerSyncAndWait(accountId, { timeout: 25_000 });

  for (const syncedEmail of syncedEmails) {
    expect(getDatabase().getEmailByXGmMsgId(accountId, syncedEmail.xGmMsgId)).to.not.equal(null);
  }

  return syncedEmails;
}

function insertSemanticChunk(
  xGmMsgId: string,
  chunkText: string,
  embedding: number[],
  accountId: number = suiteAccountId,
): void {
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

async function startChat(payload: ChatRequestPayload): Promise<string> {
  const response = await callIpc('ai:chat', payload) as IpcResponse<{ requestId: string }>;
  expect(response.success).to.equal(true);
  expect(response.data!.requestId).to.be.a('string');
  return response.data!.requestId;
}

async function waitForChatDone(requestId: string, timeoutMilliseconds: number = 20_000): Promise<ChatDonePayload> {
  const args = await waitForEvent('ai:chat:done', {
    timeout: timeoutMilliseconds,
    predicate: (eventArgs) => {
      const payload = eventArgs[0] as ChatDonePayload | undefined;
      return payload != null && payload.requestId === requestId;
    },
  });

  return args[0] as ChatDonePayload;
}

async function waitForChatSources(requestId: string, timeoutMilliseconds: number = 20_000): Promise<ChatSourcesPayload> {
  const args = await waitForEvent('ai:chat:sources', {
    timeout: timeoutMilliseconds,
    predicate: (eventArgs) => {
      const payload = eventArgs[0] as ChatSourcesPayload | undefined;
      return payload != null && payload.requestId === requestId;
    },
  });

  return args[0] as ChatSourcesPayload;
}

function getChatStreamText(requestId: string): string {
  return TestEventBus.getInstance()
    .getHistory('ai:chat:stream')
    .map((record) => record.args[0] as ChatStreamPayload)
    .filter((payload) => payload != null && payload.requestId === requestId)
    .map((payload) => payload.token)
    .join('');
}

function getChatTokenCount(requestId: string): number {
  return TestEventBus.getInstance()
    .getHistory('ai:chat:stream')
    .map((record) => record.args[0] as ChatStreamPayload)
    .filter((payload) => payload != null && payload.requestId === requestId)
    .length;
}

async function waitForCapturedRequestCount(
  endpoint: string,
  expectedCount: number,
  timeoutMilliseconds: number,
): Promise<void> {
  const startedAt = DateTime.utc().toMillis();

  while (DateTime.utc().toMillis() - startedAt < timeoutMilliseconds) {
    if (ollamaServer.getRequestsFor(endpoint).length >= expectedCount) {
      return;
    }
    await sleep(20);
  }

  throw new Error(`Timed out waiting for ${expectedCount} captured requests on ${endpoint}`);
}

async function waitForSearchComplete(
  searchToken: string,
  timeoutMilliseconds: number = 20_000,
): Promise<SearchCompletePayload> {
  const args = await waitForEvent('ai:search:complete', {
    timeout: timeoutMilliseconds,
    predicate: (eventArgs) => {
      const payload = eventArgs[0] as SearchCompletePayload | undefined;
      return payload != null && payload.searchToken === searchToken;
    },
  });

  return args[0] as SearchCompletePayload;
}

function getSearchBatchesSince(searchToken: string, priorBatchCount: number): SearchBatchPayload[] {
  return TestEventBus.getInstance()
    .getHistory('ai:search:batch')
    .slice(priorBatchCount)
    .map((record) => record.args[0] as SearchBatchPayload)
    .filter((payload) => payload != null && payload.searchToken === searchToken);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
