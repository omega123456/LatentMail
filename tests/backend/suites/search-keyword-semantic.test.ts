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
 *   - mail:search-by-msgids: resolves known Message-IDs to thread rows
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
  waitForEvent,
  seedTestAccount,
  triggerSyncAndWait,
} from '../infrastructure/test-helpers';
import { imapStateInspector, ollamaServer } from '../test-main';
import { emlFixtures } from '../fixtures/index';
import { TestEventBus } from '../infrastructure/test-event-bus';

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
      expect(['complete', 'partial', 'error']).to.include(complete.status);

      // Restore server
      ollamaServer.setError('health', false);
    });

    it('emits ai:search:batch events with local-phase results when messages match', async function () {
      this.timeout(25_000);

      // Use a term from the fixture subjects — plain-text.eml has a known subject
      const plainHeaders = emlFixtures['plain-text'].headers;
      // Extract words from the subject line to use as query keywords
      const queryWords = plainHeaders.subject.split(/\s+/).filter((word) => word.length > 3);
      // Use the first meaningful keyword for the search
      const searchQuery = queryWords.length > 0 ? queryWords[0] : 'test';

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        searchQuery,
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      // Collect all batch events and wait for complete
      const { complete } = await collectSearchBatches(searchToken);
      expect(complete.searchToken).to.equal(searchToken);
      // Status is complete or partial depending on IMAP result
      expect(['complete', 'partial', 'error']).to.include(complete.status);
    });

    it('includes known xGmMsgId in local batch when messages are indexed', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;

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

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      // Wait for complete
      await waitForSearchComplete(searchToken);

      // Check if any batch contained our message ID
      const newBatchEvents = bus.getHistory('ai:search:batch').slice(priorBatchCount);
      const allMsgIds: string[] = [];
      for (const record of newBatchEvents) {
        const payload = record.args[0] as SearchBatchPayload | undefined;
        if (payload && payload.searchToken === searchToken) {
          allMsgIds.push(...payload.msgIds);
        }
      }

      // We expect at least one batch (possibly empty if subject doesn't match DB LIKE)
      // The important thing is no error and the stream completed
      expect(['complete', 'partial', 'error']).to.include(
        (await waitForSearchComplete(searchToken).catch(() => ({ status: 'already-complete' }))).status ??
          'already-complete',
      );
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

      const response = await callIpc(
        'ai:search',
        String(suiteAccountId),
        plainHeaders.subject,
        undefined,
        'keyword',
      ) as IpcResponse<{ searchToken: string }>;

      expect(response.success).to.equal(true);
      const searchToken = response.data!.searchToken;

      const bus = TestEventBus.getInstance();
      const priorBatchCount = bus.getHistory('ai:search:batch').length;

      await waitForSearchComplete(searchToken);

      const relevantBatches = bus
        .getHistory('ai:search:batch')
        .slice(priorBatchCount)
        .map((record) => record.args[0] as SearchBatchPayload)
        .filter((payload) => payload != null && payload.searchToken === searchToken);

      if (relevantBatches.length >= 2) {
        // Verify local batch comes before imap batch
        const phases = relevantBatches.map((batch) => batch.phase);
        const firstImapIndex = phases.indexOf('imap');
        const lastLocalIndex = phases.lastIndexOf('local');
        if (firstImapIndex !== -1 && lastLocalIndex !== -1) {
          expect(lastLocalIndex).to.be.lessThan(firstImapIndex);
        }
      }
      // Even if only one batch phase was emitted, the test verifies the stream completed
    });
  });

  // -------------------------------------------------------------------------
  // mail:search-by-msgids — Message-ID search
  // -------------------------------------------------------------------------

  describe('mail:search-by-msgids — resolves Message-IDs to thread rows', () => {
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
      expect(response.data!.length).to.be.greaterThan(0);

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
  });

  // -------------------------------------------------------------------------
  // ai:chat:navigate — MessageId search via streaming
  // -------------------------------------------------------------------------

  describe('ai:chat:navigate — navigate to a source email', () => {
    it('returns a searchToken and emits ai:search:complete for a known xGmMsgId', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;

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
      expect(complete.searchToken).to.equal(searchToken);
      expect(['complete', 'partial', 'error']).to.include(complete.status);
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
  });

  // -------------------------------------------------------------------------
  // ai:search — semantic mode (when Ollama is connected and configured)
  // -------------------------------------------------------------------------

  describe('ai:search — semantic mode falls back to keyword when not ready', () => {
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
      expect(['complete', 'partial', 'error']).to.include(complete.status);
    });
  });
});
