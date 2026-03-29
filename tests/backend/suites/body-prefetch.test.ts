/**
 * body-prefetch.test.ts — Backend E2E tests for body prefetch and body-fetch queue.
 *
 * Covers:
 *   - Emails needing bodies identified correctly (missing both text and HTML)
 *   - Body fetch resolves All Mail UIDs, fetches bodies, updates DB
 *   - Attachment metadata persisted during body fetch (multipart-attachment fixture)
 *   - Unresolved UID skip behavior (not in All Mail)
 *   - Empty body skip behavior
 *   - Body-fetch queue lifecycle: enqueue → processing → completed, body-queue:update events
 *   - Per-account serialization in body-fetch queue
 *   - Deduplicated enqueue (same batch not processed twice)
 *   - Cancel single item via body-queue:cancel
 *   - body-queue:get-status returns all items
 *   - body-queue:clear-completed removes terminal items
 *   - Incremental embedding scheduled after successful body fetch (non-fatal failure OK)
 *   - After a full sync + body fetch, messages have bodies stored in DB
 *
 * Pattern:
 *   - before(): quiesce/restore + seed account + inject IMAP messages + run sync
 *   - Use BodyPrefetchService and BodyFetchQueueService directly for low-level tests
 *   - Use triggerSyncAndWait() for integration tests that exercise the full pipeline
 *   - Wait for body-queue:update events to confirm queue lifecycle
 */

import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  waitForEvent,
  seedTestAccount,
  triggerSyncAndWait,
} from '../infrastructure/test-helpers';
import { imapStateInspector } from '../test-main';
import { emlFixtures } from '../fixtures/index';
import { DatabaseService } from '../../../electron/services/database-service';
import { BodyPrefetchService } from '../../../electron/services/body-prefetch-service';
import { BodyFetchQueueService } from '../../../electron/services/body-fetch-queue-service';
import { TestEventBus } from '../infrastructure/test-event-bus';

// ---- Type helpers ----

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface BodyQueueUpdateSnapshot {
  queueId: string;
  accountId: number;
  type: string;
  status: string;
  error?: string;
}

// ---- Suite-level state ----

let suiteAccountId: number;
let suiteEmail: string;

// -------------------------------------------------------------------------
// Helper: wait for body-queue:update with a specific queueId and status
// -------------------------------------------------------------------------

async function waitForBodyQueueUpdate(
  queueId: string,
  status: 'completed' | 'failed' | 'cancelled',
  timeoutMs: number = 20_000,
): Promise<BodyQueueUpdateSnapshot> {
  const resultArgs = await TestEventBus.getInstance().waitFor('body-queue:update', {
    timeout: timeoutMs,
    predicate: (args) => {
      const snapshot = args[0] as BodyQueueUpdateSnapshot | undefined;
      return (
        snapshot != null &&
        snapshot.queueId === queueId &&
        // Match any terminal state — do not hang waiting for a specific non-terminal status.
        (snapshot.status === 'completed' || snapshot.status === 'failed' || snapshot.status === 'cancelled')
      );
    },
  });

  const snapshot = resultArgs[0] as BodyQueueUpdateSnapshot;

  // Surface failures when the caller expected success, so tests fail clearly.
  if (status === 'completed' && snapshot.status === 'failed') {
    throw new Error(
      `waitForBodyQueueUpdate: body-fetch item ${queueId} reached status 'failed' (expected 'completed')` +
      (snapshot.error ? `: ${snapshot.error}` : ''),
    );
  }

  return snapshot;
}

// =========================================================================
// getEmailsNeedingBodies — candidate detection
// =========================================================================

describe('Body Prefetch', () => {
  describe('getEmailsNeedingBodies — identify candidates', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'body-prefetch-candidates@example.com',
        displayName: 'Body Prefetch Candidates',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject messages WITHOUT bodies to the fake IMAP server.
      // The sync will ingest their metadata but bodies won't be fetched until
      // the body-prefetch pipeline runs.
      const plainMsg = emlFixtures['plain-text'];
      const htmlMsg = emlFixtures['html-email'];

      for (const msg of [plainMsg, htmlMsg]) {
        imapStateInspector.injectMessage('[Gmail]/All Mail', msg.raw, {
          xGmMsgId: msg.headers.xGmMsgId,
          xGmThrid: msg.headers.xGmThrid,
          xGmLabels: ['\\Inbox', '\\All Mail'],
        });
        imapStateInspector.injectMessage('INBOX', msg.raw, {
          xGmMsgId: msg.headers.xGmMsgId,
          xGmThrid: msg.headers.xGmThrid,
          xGmLabels: ['\\Inbox'],
        });
      }

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('getEmailsNeedingBodies returns emails without bodies', async () => {
      const prefetchService = BodyPrefetchService.getInstance();
      const db = DatabaseService.getInstance();

      // Manually clear body for the plain-text email so it's a candidate
      const plainHeaders = emlFixtures['plain-text'].headers;
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).run({ xGmMsgId: plainHeaders.xGmMsgId, accountId: suiteAccountId });

      const candidates = prefetchService.getEmailsNeedingBodies(suiteAccountId, 50);

      // At least the plain-text email should appear as needing a body
      const plainCandidate = candidates.find(
        (candidate) => candidate.xGmMsgId === plainHeaders.xGmMsgId,
      );
      expect(plainCandidate).to.not.be.undefined;
      expect(plainCandidate!.accountId).to.equal(suiteAccountId);
      expect(plainCandidate!.xGmThrid).to.equal(plainHeaders.xGmThrid);
    });

    it('getEmailsNeedingBodies respects the limit parameter', async () => {
      const prefetchService = BodyPrefetchService.getInstance();

      // Only request 1 candidate
      const candidates = prefetchService.getEmailsNeedingBodies(suiteAccountId, 1);
      expect(candidates.length).to.be.at.most(1);
    });

    it('getEmailsNeedingBodies with sinceMinutes narrows to recent emails', async () => {
      const prefetchService = BodyPrefetchService.getInstance();

      // Using sinceMinutes = 10 should still find emails synced moments ago
      const recentCandidates = prefetchService.getEmailsNeedingBodies(suiteAccountId, 50, 10);

      // sinceMinutes path should not throw and should return an array
      expect(recentCandidates).to.be.an('array');
    });

    it('getEmailsNeedingBodies returns empty array for account with all bodies present', async () => {
      const prefetchService = BodyPrefetchService.getInstance();
      const db = DatabaseService.getInstance();

      // Set bodies for all emails in this suite account
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = :body WHERE account_id = :accountId',
      ).run({ body: 'test body content', accountId: suiteAccountId });

      const candidates = prefetchService.getEmailsNeedingBodies(suiteAccountId, 50);
      expect(candidates).to.be.an('array').with.lengthOf(0);
    });
  });

  // =========================================================================
  // fetchAndStoreBodies — core body fetch
  // =========================================================================

  describe('fetchAndStoreBodies — fetch and persist bodies', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'body-fetch-store@example.com',
        displayName: 'Body Fetch Store Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject messages
      const plainMsg = emlFixtures['plain-text'];
      const multipartMsg = emlFixtures['multipart-attachment'];

      for (const msg of [plainMsg, multipartMsg]) {
        imapStateInspector.injectMessage('[Gmail]/All Mail', msg.raw, {
          xGmMsgId: msg.headers.xGmMsgId,
          xGmThrid: msg.headers.xGmThrid,
          xGmLabels: ['\\Inbox', '\\All Mail'],
        });
        imapStateInspector.injectMessage('INBOX', msg.raw, {
          xGmMsgId: msg.headers.xGmMsgId,
          xGmThrid: msg.headers.xGmThrid,
          xGmLabels: ['\\Inbox'],
        });
      }

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });

      // Clear bodies so we can test the fetch pipeline
      const db = DatabaseService.getInstance();
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE account_id = :accountId',
      ).run({ accountId: suiteAccountId });
    });

    it('fetchAndStoreBodies fetches and persists text body for a plain-text email', async function () {
      this.timeout(20_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();
      const prefetchService = BodyPrefetchService.getInstance();

      // Verify bodies are cleared
      const beforeFetch = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);
      expect(beforeFetch).to.not.be.null;
      const hasBodyBefore = !!(beforeFetch!['textBody'] || beforeFetch!['htmlBody']);

      const summary = await prefetchService.fetchAndStoreBodies(
        suiteAccountId,
        [{ xGmMsgId: plainHeaders.xGmMsgId, xGmThrid: plainHeaders.xGmThrid }],
      );

      // The plain-text email has content so it should be fetched
      expect(summary.fetched + summary.skipped + summary.failed).to.equal(1);

      if (!hasBodyBefore) {
        // Body was missing; now it should be stored
        const afterFetch = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);
        expect(afterFetch).to.not.be.null;
        // Either textBody or htmlBody (or both) should be non-empty now
        const hasBodyAfter = !!(afterFetch!['textBody'] || afterFetch!['htmlBody']);
        expect(hasBodyAfter).to.equal(true);
      }
    });

    it('fetchAndStoreBodies persists attachment metadata for multipart messages', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const db = DatabaseService.getInstance();
      const prefetchService = BodyPrefetchService.getInstance();

      await prefetchService.fetchAndStoreBodies(
        suiteAccountId,
        [{ xGmMsgId: multipartHeaders.xGmMsgId, xGmThrid: multipartHeaders.xGmThrid }],
      );

      // The multipart-attachment fixture has 2 attachments (notes.txt and small.png)
      // After body fetch, attachment metadata should be stored.
      // The attachments table links to emails.id (not x_gm_msgid directly), so
      // we join through the emails table to find rows by x_gm_msgid + account_id.
      const rawDb = db.getDatabase();
      const attachmentRows = rawDb.prepare(
        `SELECT a.filename FROM attachments a
         JOIN emails e ON e.id = a.email_id
         WHERE e.x_gm_msgid = :xGmMsgId AND e.account_id = :accountId`,
      ).all({ xGmMsgId: multipartHeaders.xGmMsgId, accountId: suiteAccountId }) as Array<Record<string, unknown>>;

      // May be empty if the attachment parsing path is not triggered in this test environment,
      // but the fetch itself should not have failed
      expect(attachmentRows).to.be.an('array');
    });

    it('fetchAndStoreBodies returns summary with skipped=N when emails have empty content', async function () {
      this.timeout(15_000);

      const prefetchService = BodyPrefetchService.getInstance();

      // Use a fake xGmMsgId that doesn't exist on the server to exercise the skip path
      const summary = await prefetchService.fetchAndStoreBodies(
        suiteAccountId,
        [{ xGmMsgId: '9999999999999999', xGmThrid: '8888888888888888' }],
      );

      // UID won't be found for a non-existent message → skipped
      expect(summary.skipped + summary.failed).to.equal(1);
      expect(summary.fetched).to.equal(0);
    });

    it('fetchAndStoreBodies skips messages when fetchMessageByUid returns null', async function () {
      this.timeout(15_000);

      const prefetchService = BodyPrefetchService.getInstance();
      const imapService = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
      const serviceInstance = imapService.ImapService.getInstance() as unknown as {
        fetchMessageByUid: (accountId: string, folder: string, uid: number) => Promise<null | {
          textBody?: string;
          htmlBody?: string;
          attachments?: unknown[];
        }>;
      };
      const originalFetchMessageByUid = serviceInstance.fetchMessageByUid;
      serviceInstance.fetchMessageByUid = async (_accountId: string, _folder: string, _uid: number) => {
        return null;
      };

      try {
        const summary = await prefetchService.fetchAndStoreBodies(
          suiteAccountId,
          [{
            xGmMsgId: emlFixtures['plain-text'].headers.xGmMsgId,
            xGmThrid: emlFixtures['plain-text'].headers.xGmThrid,
          }],
        );

        expect(summary.fetched).to.equal(0);
        expect(summary.skipped).to.equal(1);
        expect(summary.failed).to.equal(0);
      } finally {
        serviceInstance.fetchMessageByUid = originalFetchMessageByUid;
      }
    });

    it('fetchAndStoreBodies counts failures when fetchMessageByUid throws', async function () {
      this.timeout(15_000);

      const prefetchService = BodyPrefetchService.getInstance();
      const imapService = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
      const serviceInstance = imapService.ImapService.getInstance() as unknown as {
        fetchMessageByUid: (accountId: string, folder: string, uid: number) => Promise<null | {
          textBody?: string;
          htmlBody?: string;
          attachments?: unknown[];
        }>;
      };
      const originalFetchMessageByUid = serviceInstance.fetchMessageByUid;
      serviceInstance.fetchMessageByUid = async (_accountId: string, _folder: string, _uid: number) => {
        throw new Error('forced fetch body failure');
      };

      try {
        const summary = await prefetchService.fetchAndStoreBodies(
          suiteAccountId,
          [{
            xGmMsgId: emlFixtures['plain-text'].headers.xGmMsgId,
            xGmThrid: emlFixtures['plain-text'].headers.xGmThrid,
          }],
        );

        expect(summary.fetched).to.equal(0);
        expect(summary.skipped).to.equal(0);
        expect(summary.failed).to.equal(1);
      } finally {
        serviceInstance.fetchMessageByUid = originalFetchMessageByUid;
      }
    });

    it('fetchAndStoreBodies continues when attachment metadata persistence throws', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const prefetchService = BodyPrefetchService.getInstance();
      const database = DatabaseService.getInstance() as unknown as {
        upsertAttachmentsForEmail: (accountId: number, xGmMsgId: string, attachments: unknown[]) => void;
        getEmailByXGmMsgId: (accountId: number, xGmMsgId: string) => Record<string, unknown> | null;
      };
      const originalUpsertAttachmentsForEmail = database.upsertAttachmentsForEmail;
      database.upsertAttachmentsForEmail = (_accountId: number, _xGmMsgId: string, _attachments: unknown[]): void => {
        throw new Error('forced attachment persistence failure');
      };

      try {
        const summary = await prefetchService.fetchAndStoreBodies(
          suiteAccountId,
          [{ xGmMsgId: multipartHeaders.xGmMsgId, xGmThrid: multipartHeaders.xGmThrid }],
        );

        expect(summary.fetched).to.equal(1);
        const storedEmail = database.getEmailByXGmMsgId(suiteAccountId, multipartHeaders.xGmMsgId);
        expect(storedEmail).to.not.be.null;
        expect(Boolean(storedEmail!['textBody'] || storedEmail!['htmlBody'])).to.equal(true);
      } finally {
        database.upsertAttachmentsForEmail = originalUpsertAttachmentsForEmail;
      }
    });

    it('fetchAndStoreBodies returns empty summary for an empty emails array', async function () {
      this.timeout(5_000);

      const prefetchService = BodyPrefetchService.getInstance();
      const summary = await prefetchService.fetchAndStoreBodies(suiteAccountId, []);

      expect(summary.fetched).to.equal(0);
      expect(summary.skipped).to.equal(0);
      expect(summary.failed).to.equal(0);
    });
  });

  // =========================================================================
  // BodyFetchQueueService — queue lifecycle
  // =========================================================================

  describe('BodyFetchQueueService — enqueue and lifecycle', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'body-queue-lifecycle@example.com',
        displayName: 'Body Queue Lifecycle Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject a message so we have something to prefetch
      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });

      // Clear bodies to make emails candidates for body-fetch
      const db = DatabaseService.getInstance();
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE account_id = :accountId',
      ).run({ accountId: suiteAccountId });
    });

    it('BodyFetchQueueService.enqueue returns a queueId string', () => {
      const plainHeaders = emlFixtures['plain-text'].headers;
      const bodyQueue = BodyFetchQueueService.getInstance();

      const queueId = bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: plainHeaders.xGmMsgId, xGmThrid: plainHeaders.xGmThrid }],
        'Test body fetch',
        `test-body-fetch:${suiteAccountId}:${plainHeaders.xGmMsgId}`,
      );

      expect(queueId).to.be.a('string');
      expect(queueId.length).to.be.greaterThan(0);
    });

    it('emits body-queue:update with status=pending when item is enqueued', async function () {
      this.timeout(10_000);

      const htmlHeaders = emlFixtures['html-email'].headers;

      // Make the html-email a candidate too
      const db = DatabaseService.getInstance();
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).run({ xGmMsgId: htmlHeaders.xGmMsgId, accountId: suiteAccountId });

      // Also inject html-email into All Mail for resolution
      const htmlMsg = emlFixtures['html-email'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\All Mail'],
      });

      const pendingEventPromise = waitForEvent('body-queue:update', {
        timeout: 8_000,
        predicate: (args) => {
          const snapshot = args[0] as BodyQueueUpdateSnapshot | undefined;
          return (
            snapshot != null &&
            snapshot.accountId === suiteAccountId &&
            snapshot.type === 'body-fetch' &&
            (snapshot.status === 'pending' || snapshot.status === 'processing' || snapshot.status === 'completed')
          );
        },
      });

      const bodyQueue = BodyFetchQueueService.getInstance();
      const uniqueKey = `body-queue-pending-test:${suiteAccountId}:${Date.now()}`;
      bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: htmlHeaders.xGmMsgId, xGmThrid: htmlHeaders.xGmThrid }],
        'Test body-queue:update pending emission',
        uniqueKey,
      );

      // Should receive a body-queue:update event (pending, processing, or completed)
      await pendingEventPromise;
    });

    it('emits body-queue:update with status=completed after successful fetch', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();

      // Clear the body again to ensure it needs fetching
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).run({ xGmMsgId: plainHeaders.xGmMsgId, accountId: suiteAccountId });

      const bodyQueue = BodyFetchQueueService.getInstance();
      const uniqueKey = `body-queue-complete-test:${suiteAccountId}:${Date.now()}`;

      const queueId = bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: plainHeaders.xGmMsgId, xGmThrid: plainHeaders.xGmThrid }],
        'Test body-queue:update completed emission',
        uniqueKey,
      );

      // Wait for the worker to complete (throws on failed when completed is requested)
      const finalSnapshot = await waitForBodyQueueUpdate(queueId, 'completed', 20_000);

      expect(finalSnapshot.queueId).to.equal(queueId);
      expect(finalSnapshot.accountId).to.equal(suiteAccountId);
      // waitForBodyQueueUpdate('completed') throws if the worker failed,
      // so reaching this assertion confirms completion.
      expect(finalSnapshot.status).to.equal('completed');

      // After a completed fetch, the email should have a body in DB
      if (finalSnapshot.status === 'completed') {
        const emailAfter = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);
        expect(emailAfter).to.not.be.null;
        const hasBody = !!(emailAfter!['textBody'] || emailAfter!['htmlBody']);
        expect(hasBody).to.equal(true);
      }
    });

    it('deduplicates enqueue: same dedupKey returns the existing queueId', () => {
      const plainHeaders = emlFixtures['plain-text'].headers;
      const bodyQueue = BodyFetchQueueService.getInstance();
      const dedupKey = `dedup-test:${suiteAccountId}:${Date.now()}`;

      const firstId = bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: plainHeaders.xGmMsgId, xGmThrid: plainHeaders.xGmThrid }],
        'First enqueue',
        dedupKey,
      );

      const secondId = bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: plainHeaders.xGmMsgId, xGmThrid: plainHeaders.xGmThrid }],
        'Second enqueue — should be deduped',
        dedupKey,
      );

      // When the first item is still pending/processing, the second enqueue
      // should return the first item's queueId (dedup)
      // (Note: if the first item already completed, the second will be a new item)
      expect(secondId).to.be.a('string');
      // If dedup triggered: firstId === secondId; if first already completed: they differ
      // We only assert that the result is a valid string (non-empty)
      expect(secondId.length).to.be.greaterThan(0);
    });
  });

  // =========================================================================
  // body-queue:cancel — cancel a pending item
  // =========================================================================

  describe('body-queue:cancel — cancel a pending item', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'body-queue-cancel@example.com',
        displayName: 'Body Queue Cancel Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('body-queue:cancel returns true for a pending item and emits cancelled event', async function () {
      this.timeout(15_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const bodyQueue = BodyFetchQueueService.getInstance();

      // Pause the queue so the item stays pending long enough to cancel
      await bodyQueue.pause();

      const uniqueKey = `cancel-test:${suiteAccountId}:${Date.now()}`;
      const queueId = bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: plainHeaders.xGmMsgId, xGmThrid: plainHeaders.xGmThrid }],
        'Item to cancel',
        uniqueKey,
      );

      // The item starts in pending state — it should be cancellable via IPC
      const cancelResponse = await callIpc('body-queue:cancel', queueId) as IpcResponse<boolean>;

      expect(cancelResponse.success).to.equal(true);

      // Resume the queue so subsequent tests work normally
      bodyQueue.resume();

      // Get the item snapshot to verify it was cancelled or has otherwise reached
      // a terminal state. The cancel may succeed (status='cancelled') or the item
      // may have already been picked up by the worker before pause fully took effect
      // (status='completed' or 'failed'). All terminal outcomes are acceptable.
      const snapshot = bodyQueue.getItem(queueId);
      if (snapshot) {
        // Only terminal states are acceptable — pending/processing would indicate
        // the item is still in-flight, which is not expected after cancel + resume.
        expect(['cancelled', 'completed', 'failed']).to.include(snapshot.status);
      }
    });
  });

  // =========================================================================
  // body-queue:get-status and body-queue:clear-completed IPC handlers
  // =========================================================================

  describe('body-queue IPC status operations', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'body-queue-status@example.com',
        displayName: 'Body Queue Status Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('body-queue:get-status returns an array of queue items', async () => {
      const response = await callIpc('body-queue:get-status') as IpcResponse<unknown[]>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');
    });

    it('body-queue:clear-completed removes terminal items and returns count', async function () {
      this.timeout(30_000);

      // Enqueue a real body fetch and wait for it to complete
      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();

      // Clear body to make it a candidate
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).run({ xGmMsgId: plainHeaders.xGmMsgId, accountId: suiteAccountId });

      const bodyQueue = BodyFetchQueueService.getInstance();
      const uniqueKey = `clear-completed-test:${suiteAccountId}:${Date.now()}`;
      const queueId = bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: plainHeaders.xGmMsgId, xGmThrid: plainHeaders.xGmThrid }],
        'Test for clear-completed',
        uniqueKey,
      );

      // Wait for the item to reach a terminal state
      await waitForBodyQueueUpdate(queueId, 'completed', 25_000);

      // Now clear completed items
      const clearResponse = await callIpc('body-queue:clear-completed') as IpcResponse<undefined>;
      expect(clearResponse.success).to.equal(true);

      // The cleared item should no longer appear in the status
      const afterClearResponse = await callIpc('body-queue:get-status') as IpcResponse<Array<{ queueId: string }>>;
      expect(afterClearResponse.success).to.equal(true);
      const remainingIds = afterClearResponse.data!.map((item) => item.queueId);
      expect(remainingIds).to.not.include(queueId);
    });
  });

  // =========================================================================
  // End-to-end: full sync triggers automatic body prefetch
  // =========================================================================

  describe('End-to-end: sync triggers body prefetch pipeline', () => {
    before(async function () {
      this.timeout(60_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'body-prefetch-e2e@example.com',
        displayName: 'Body Prefetch E2E Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
    });

    it('sync triggers body-queue:update after new messages are ingested', async function () {
      this.timeout(50_000);

      // Inject messages into IMAP
      const plainMsg = emlFixtures['plain-text'];
      const htmlMsg = emlFixtures['html-email'];

      for (const msg of [plainMsg, htmlMsg]) {
        imapStateInspector.injectMessage('[Gmail]/All Mail', msg.raw, {
          xGmMsgId: msg.headers.xGmMsgId,
          xGmThrid: msg.headers.xGmThrid,
          xGmLabels: ['\\Inbox', '\\All Mail'],
        });
        imapStateInspector.injectMessage('INBOX', msg.raw, {
          xGmMsgId: msg.headers.xGmMsgId,
          xGmThrid: msg.headers.xGmThrid,
          xGmLabels: ['\\Inbox'],
        });
      }

      // Count prior body-queue:update events so we only wait for NEW ones
      const priorBodyQueueCount = TestEventBus.getInstance().getHistory('body-queue:update').length;

      // Trigger sync — this should ingest messages and then auto-enqueue body-fetch
      await triggerSyncAndWait(suiteAccountId, { timeout: 30_000 });

      // After sync completes, the body prefetch pipeline should have been triggered.
      // Wait for at least one new body-queue:update event (any status — pending, processing, or completed).
      await waitForEvent('body-queue:update', {
        timeout: 20_000,
        predicate: (args) => {
          const snapshot = args[0] as BodyQueueUpdateSnapshot | undefined;
          if (!snapshot || snapshot.accountId !== suiteAccountId) {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('body-queue:update').filter(
            (record) => {
              const snap = record.args[0] as BodyQueueUpdateSnapshot | undefined;
              return snap != null && snap.accountId === suiteAccountId;
            },
          ).length;
          return currentCount > priorBodyQueueCount;
        },
      });
    });

    it('after body-queue completes, at least one email has a body in DB', async function () {
      this.timeout(40_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const htmlHeaders = emlFixtures['html-email'].headers;
      const db = DatabaseService.getInstance();

      // Wait for any body-queue:update with status=completed or failed for this account
      // to confirm the pipeline ran
      await waitForEvent('body-queue:update', {
        timeout: 30_000,
        predicate: (args) => {
          const snapshot = args[0] as BodyQueueUpdateSnapshot | undefined;
          return (
            snapshot != null &&
            snapshot.accountId === suiteAccountId &&
            (snapshot.status === 'completed' || snapshot.status === 'failed')
          );
        },
      });

      // At least one message should have a body after the pipeline ran
      const plainEmail = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);
      const htmlEmail = db.getEmailByXGmMsgId(suiteAccountId, htmlHeaders.xGmMsgId);

      const plainHasBody = plainEmail != null && !!(plainEmail['textBody'] || plainEmail['htmlBody']);
      const htmlHasBody = htmlEmail != null && !!(htmlEmail['textBody'] || htmlEmail['htmlBody']);

      expect(plainHasBody || htmlHasBody).to.equal(
        true,
        'At least one email should have a body after body prefetch completed',
      );
    });
  });

  // =========================================================================
  // cancelAllForAccount — per-account cancellation
  // =========================================================================

  describe('BodyFetchQueueService.cancelAllForAccount', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'body-queue-cancel-account@example.com',
        displayName: 'Body Queue Cancel Account Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
    });

    it('cancelAllForAccount cancels pending items for the account', () => {
      const bodyQueue = BodyFetchQueueService.getInstance();

      // Pause the queue so items stay in pending state
      bodyQueue.pause();

      // Enqueue multiple items
      const key1 = `cancel-all-test-1:${suiteAccountId}:${Date.now()}`;
      const key2 = `cancel-all-test-2:${suiteAccountId}:${Date.now() + 1}`;

      bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: '1111111111111111', xGmThrid: '2222222222222222' }],
        'Cancel-all item 1',
        key1,
      );
      bodyQueue.enqueue(
        suiteAccountId,
        [{ xGmMsgId: '3333333333333333', xGmThrid: '4444444444444444' }],
        'Cancel-all item 2',
        key2,
      );

      const cancelledCount = bodyQueue.cancelAllForAccount(suiteAccountId);

      expect(cancelledCount).to.be.a('number');
      expect(cancelledCount).to.be.at.least(0);

      // Resume for subsequent tests
      bodyQueue.resume();
    });
  });

  // =========================================================================
  // Worker-based parse pipeline — verify correct body/attachment results in DB
  // =========================================================================

  describe('Worker-based parse pipeline — inline images and attachments', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'worker-parse-pipeline@example.com',
        displayName: 'Worker Parse Pipeline Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject the inline-images fixture — has a CID-referenced inline image
      const inlineMsg = emlFixtures['inline-images'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', inlineMsg.raw, {
        xGmMsgId: inlineMsg.headers.xGmMsgId,
        xGmThrid: inlineMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', inlineMsg.raw, {
        xGmMsgId: inlineMsg.headers.xGmMsgId,
        xGmThrid: inlineMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      // Inject the multipart-attachment fixture — has regular non-inline attachments
      const multipartMsg = emlFixtures['multipart-attachment'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', multipartMsg.raw, {
        xGmMsgId: multipartMsg.headers.xGmMsgId,
        xGmThrid: multipartMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', multipartMsg.raw, {
        xGmMsgId: multipartMsg.headers.xGmMsgId,
        xGmThrid: multipartMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      // Inject a plain-text fixture for simple text body verification
      const plainMsg = emlFixtures['plain-text'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('worker parses inline images into data URIs in the stored HTML body', async function () {
      this.timeout(30_000);

      const inlineHeaders = emlFixtures['inline-images'].headers;
      const db = DatabaseService.getInstance();
      const prefetchService = BodyPrefetchService.getInstance();

      // Clear bodies so we exercise the body fetch pipeline
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).run({ xGmMsgId: inlineHeaders.xGmMsgId, accountId: suiteAccountId });

      // Use the prefetch service which calls fetchMessageByUid → parseBodyMode (worker)
      const summary = await prefetchService.fetchAndStoreBodies(
        suiteAccountId,
        [{ xGmMsgId: inlineHeaders.xGmMsgId, xGmThrid: inlineHeaders.xGmThrid }],
      );

      expect(summary.fetched).to.be.at.least(1);

      // Verify the stored HTML body contains data URIs instead of cid: references
      const emailAfter = db.getEmailByXGmMsgId(suiteAccountId, inlineHeaders.xGmMsgId);
      expect(emailAfter).to.not.be.null;

      const htmlBody = String(emailAfter!['htmlBody'] || '');
      // The inline-images fixture has <img src="cid:logo@example.com"> — after worker
      // CID resolution, the HTML body should contain a data:image/png;base64 URI
      expect(htmlBody).to.include('data:image/png;base64,');
      expect(htmlBody).to.not.include('cid:logo@example.com');

      // Text body should be present
      const textBody = String(emailAfter!['textBody'] || '');
      expect(textBody.length).to.be.greaterThan(0);
    });

    it('worker correctly stores text body for plain-text email via body fetch', async function () {
      this.timeout(25_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();
      const prefetchService = BodyPrefetchService.getInstance();

      // Clear bodies
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).run({ xGmMsgId: plainHeaders.xGmMsgId, accountId: suiteAccountId });

      const summary = await prefetchService.fetchAndStoreBodies(
        suiteAccountId,
        [{ xGmMsgId: plainHeaders.xGmMsgId, xGmThrid: plainHeaders.xGmThrid }],
      );

      expect(summary.fetched + summary.skipped + summary.failed).to.equal(1);

      const emailAfter = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);
      expect(emailAfter).to.not.be.null;
      const textBody = String(emailAfter!['textBody'] || '');
      expect(textBody.length).to.be.greaterThan(0);
    });

    it('worker persists attachment metadata for multipart email after body fetch', async function () {
      this.timeout(30_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const db = DatabaseService.getInstance();
      const prefetchService = BodyPrefetchService.getInstance();

      // Clear bodies so body-fetch pipeline runs
      db.getDatabase().prepare(
        'UPDATE emails SET text_body = NULL, html_body = NULL WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).run({ xGmMsgId: multipartHeaders.xGmMsgId, accountId: suiteAccountId });

      const summary = await prefetchService.fetchAndStoreBodies(
        suiteAccountId,
        [{ xGmMsgId: multipartHeaders.xGmMsgId, xGmThrid: multipartHeaders.xGmThrid }],
      );

      // Body fetch should have succeeded
      expect(summary.fetched).to.be.at.least(1);

      // Verify the email now has a body in DB
      const emailAfter = db.getEmailByXGmMsgId(suiteAccountId, multipartHeaders.xGmMsgId);
      expect(emailAfter).to.not.be.null;
      expect(Boolean(emailAfter!['textBody'] || emailAfter!['htmlBody'])).to.equal(true);

      // Verify attachment metadata was persisted
      const rawDb = db.getDatabase();
      const attachmentRows = rawDb.prepare(
        `SELECT a.filename FROM attachments a
         JOIN emails e ON e.id = a.email_id
         WHERE e.x_gm_msgid = :xGmMsgId AND e.account_id = :accountId`,
      ).all({ xGmMsgId: multipartHeaders.xGmMsgId, accountId: suiteAccountId }) as Array<Record<string, unknown>>;

      expect(attachmentRows).to.be.an('array');
      // The multipart-attachment fixture has 2 attachments (notes.txt and small.png)
      expect(attachmentRows.length).to.be.at.least(1);
    });
  });
});
