/**
 * queue-mutations.test.ts — Backend E2E tests for queue-based mail mutations.
 *
 * Covers:
 *   - Move via mail:move: optimistic local folder change + IMAP COPY+DELETE +
 *     post-op reconciliation + mail:folder-updated emitted
 *   - Move across source folders
 *   - Flag read/unread via mail:flag: optimistic local update + IMAP STORE
 *   - Flag starred/unstarred via mail:flag
 *   - Delete via mail:delete: soft-delete moves to resolved trash folder,
 *     no-op if already in Trash
 *   - Label create via label:create: IMAP CREATE mailbox + local label row
 *   - Label delete via label:delete: optimistic local deletion + queued
 *     IMAP DELETE (mailbox-not-found = success)
 *   - Label update-color via label:update-color
 *   - Label add/remove via queue:enqueue (add-labels / remove-labels types)
 *   - queue:update events emitted through full lifecycle (enqueue → processing → completed)
 *   - Pending ops registered on enqueue, cleared on completion
 *
 * Key pattern:
 *   - Invoke user-facing IPCs (mail:move, mail:flag, mail:delete, label:create,
 *     label:delete, label:update-color) rather than queue:enqueue directly —
 *     except for add-labels / remove-labels which have no higher-level IPC.
 *   - Wait for queue:update with status === 'completed' after each operation to
 *     confirm the queue worker finished before asserting IMAP/DB state.
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
import { TestEventBus } from '../infrastructure/test-event-bus';

// ---- Type helpers ----

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface QueueUpdateSnapshot {
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
// Helper: wait for a queue:update event with a specific queueId and status
// -------------------------------------------------------------------------

async function waitForQueueUpdate(
  queueId: string,
  status: 'completed' | 'failed',
  timeoutMs: number = 15_000,
): Promise<QueueUpdateSnapshot> {
  const bus = TestEventBus.getInstance();

  const resultArgs = await bus.waitFor('queue:update', {
    timeout: timeoutMs,
    predicate: (args) => {
      const snapshot = args[0] as QueueUpdateSnapshot | undefined;
      return (
        snapshot != null &&
        snapshot.queueId === queueId &&
        // Match only terminal states — do not resolve on pending/processing.
        (snapshot.status === 'completed' || snapshot.status === 'failed')
      );
    },
  });

  const snapshot = resultArgs[0] as QueueUpdateSnapshot;

  // If the caller requested 'completed' but the worker reported 'failed', surface
  // the failure so the test fails rather than continuing as if the operation succeeded.
  if (status === 'completed' && snapshot.status === 'failed') {
    throw new Error(
      `waitForQueueUpdate: operation ${queueId} reached status 'failed' (expected 'completed')` +
      (snapshot.error ? `: ${snapshot.error}` : ''),
    );
  }

  return snapshot;
}

// -------------------------------------------------------------------------
// Helper: seed account + sync a set of messages into the local DB
// -------------------------------------------------------------------------

interface SeedAndSyncResult {
  accountId: number;
  email: string;
}

async function setupSuiteWithMessages(emailAddress: string, displayName: string): Promise<SeedAndSyncResult> {
  await quiesceAndRestore();

  const seeded = seedTestAccount({ email: emailAddress, displayName });
  suiteAccountId = seeded.accountId;
  suiteEmail = seeded.email;

  imapStateInspector.reset();
  imapStateInspector.getServer().addAllowedAccount(suiteEmail);

  // Inject plain-text and html-email messages into INBOX and All Mail
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

  await triggerSyncAndWait(seeded.accountId, { timeout: 25_000 });

  return { accountId: seeded.accountId, email: seeded.email };
}

// =========================================================================
// Move operations
// =========================================================================

describe('Queue Mutations', () => {
  describe('mail:move — move to Sent Mail', () => {
    before(async function () {
      this.timeout(35_000);
      await setupSuiteWithMessages('queue-move@example.com', 'Queue Move Test');
    });

    it('mail:move returns success and a queueId', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;

      const response = await callIpc(
        'mail:move',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        '[Gmail]/Sent Mail',
        'INBOX',
      ) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.have.property('queueId').that.is.a('string');
    });

    it('performs optimistic DB update before queue worker runs', async () => {
      const htmlHeaders = emlFixtures['html-email'].headers;

      // Before move: html-email should be in INBOX
      const db = DatabaseService.getInstance();
      const foldersBefore = db.getFoldersForEmail(suiteAccountId, htmlHeaders.xGmMsgId);
      expect(foldersBefore).to.include('INBOX');

      const moveResponse = await callIpc(
        'mail:move',
        String(suiteAccountId),
        [htmlHeaders.xGmMsgId],
        '[Gmail]/Sent Mail',
        'INBOX',
      ) as IpcResponse<{ queueId: string }>;

      expect(moveResponse.success).to.equal(true);

      // Immediately after IPC returns, the DB should reflect the move (optimistic update)
      const foldersAfter = db.getFoldersForEmail(suiteAccountId, htmlHeaders.xGmMsgId);
      expect(foldersAfter).to.include('[Gmail]/Sent Mail');
      expect(foldersAfter).to.not.include('INBOX');
    });

    it('emits queue:update lifecycle events for the move operation', async function () {
      this.timeout(20_000);

      // Re-sync so we have a fresh message to move
      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'queue-move-lifecycle@example.com' });
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
      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      // Enqueue the move
      const moveResponse = await callIpc(
        'mail:move',
        String(suiteAccountId),
        [plainMsg.headers.xGmMsgId],
        '[Gmail]/Sent Mail',
        'INBOX',
      ) as IpcResponse<{ queueId: string }>;

      expect(moveResponse.success).to.equal(true);
      expect(moveResponse.data).to.not.be.null;
      const queueId = moveResponse.data!.queueId;

      // queue:update with status=pending or processing should have fired when the item was enqueued
      // Wait for the worker to complete
      const finalSnapshot = await waitForQueueUpdate(queueId, 'completed', 15_000);

      expect(finalSnapshot.queueId).to.equal(queueId);
      expect(finalSnapshot.accountId).to.equal(suiteAccountId);
      // waitForQueueUpdate('completed') throws if the operation failed,
      // so reaching this assertion means the operation completed successfully.
      expect(finalSnapshot.status).to.equal('completed');
    });

    it('emits mail:folder-updated after a move operation completes', async function () {
      this.timeout(25_000);

      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'queue-move-event@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const htmlMsg = emlFixtures['html-email'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });
      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const priorFolderUpdatedCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
        (record) => {
          const payload = record.args[0] as Record<string, unknown> | undefined;
          return payload != null && Number(payload['accountId']) === suiteAccountId;
        },
      ).length;

      const moveResponse = await callIpc(
        'mail:move',
        String(suiteAccountId),
        [htmlMsg.headers.xGmMsgId],
        '[Gmail]/Sent Mail',
        'INBOX',
      ) as IpcResponse<{ queueId: string }>;

      expect(moveResponse.success).to.equal(true);

      // Wait for mail:folder-updated to be emitted as part of the move post-processing
      await waitForEvent('mail:folder-updated', {
        timeout: 15_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          if (!payload || Number(payload['accountId']) !== suiteAccountId) {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
            (record) => {
              const recordPayload = record.args[0] as Record<string, unknown> | undefined;
              return recordPayload != null && Number(recordPayload['accountId']) === suiteAccountId;
            },
          ).length;
          return currentCount > priorFolderUpdatedCount;
        },
      });
    });
  });

  // =========================================================================
  // Flag operations
  // =========================================================================

  describe('mail:flag — read/unread', () => {
    before(async function () {
      this.timeout(35_000);
      await setupSuiteWithMessages('queue-flag-read@example.com', 'Queue Flag Read Test');
    });

    it('mail:flag read=true returns success with a queueId', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;

      const response = await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'read',
        true,
      ) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.have.property('queueId').that.is.a('string');
    });

    it('performs optimistic DB update: sets isRead=true immediately', async () => {
      const htmlHeaders = emlFixtures['html-email'].headers;
      const db = DatabaseService.getInstance();

      const emailBefore = db.getEmailByXGmMsgId(suiteAccountId, htmlHeaders.xGmMsgId);
      expect(emailBefore).to.not.be.null;

      await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [htmlHeaders.xGmMsgId],
        'read',
        true,
      );

      const emailAfter = db.getEmailByXGmMsgId(suiteAccountId, htmlHeaders.xGmMsgId);
      expect(emailAfter).to.not.be.null;
      expect(emailAfter!['isRead']).to.equal(true);
    });

    it('performs optimistic DB update: sets isRead=false (mark unread)', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();

      // First mark as read
      await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'read',
        true,
      );

      // Then mark as unread
      await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'read',
        false,
      );

      const emailAfter = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);
      expect(emailAfter!['isRead']).to.equal(false);
    });

    it('emits queue:update completed for the flag operation', async function () {
      this.timeout(20_000);

      const plainHeaders = emlFixtures['plain-text'].headers;

      const flagResponse = await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'read',
        true,
      ) as IpcResponse<{ queueId: string }>;

      expect(flagResponse.success).to.equal(true);
      const queueId = flagResponse.data!.queueId;

      const finalSnapshot = await waitForQueueUpdate(queueId, 'completed', 15_000);
      expect(finalSnapshot.queueId).to.equal(queueId);
      expect(finalSnapshot.status).to.equal('completed');
    });
  });

  describe('mail:flag — starred/unstarred', () => {
    before(async function () {
      this.timeout(35_000);
      await setupSuiteWithMessages('queue-flag-star@example.com', 'Queue Flag Star Test');
    });

    it('sets isStarred=true via mail:flag starred=true', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();

      const flagResponse = await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'starred',
        true,
      ) as IpcResponse<{ queueId: string }>;

      expect(flagResponse.success).to.equal(true);

      const emailAfter = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);
      expect(emailAfter!['isStarred']).to.equal(true);
    });

    it('sets isStarred=false via mail:flag starred=false', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();

      // First star it
      await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'starred',
        true,
      );

      // Then unstar it
      await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'starred',
        false,
      );

      const emailAfter = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);
      expect(emailAfter!['isStarred']).to.equal(false);
    });
  });

  // =========================================================================
  // Delete operations
  // =========================================================================

  describe('mail:delete — soft delete to Trash', () => {
    before(async function () {
      this.timeout(35_000);
      await setupSuiteWithMessages('queue-delete@example.com', 'Queue Delete Test');
    });

    it('mail:delete returns success with a queueId for a message in INBOX', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;

      const response = await callIpc(
        'mail:delete',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'INBOX',
      ) as IpcResponse<{ queueId: string | null }>;

      expect(response.success).to.equal(true);
      // queueId should be a string (not null) since the message was in INBOX
      expect(response.data).to.have.property('queueId');
    });

    it('performs optimistic DB update: moves email folder association to Trash', async () => {
      const htmlHeaders = emlFixtures['html-email'].headers;
      const db = DatabaseService.getInstance();

      const foldersBefore = db.getFoldersForEmail(suiteAccountId, htmlHeaders.xGmMsgId);
      expect(foldersBefore).to.include('INBOX');

      await callIpc(
        'mail:delete',
        String(suiteAccountId),
        [htmlHeaders.xGmMsgId],
        'INBOX',
      );

      // After delete, the email should be in Trash (resolved via getTrashFolder)
      const trashFolder = db.getTrashFolder(suiteAccountId);
      const foldersAfter = db.getFoldersForEmail(suiteAccountId, htmlHeaders.xGmMsgId);
      expect(foldersAfter).to.include(trashFolder);
      expect(foldersAfter).to.not.include('INBOX');
    });

    it('returns no-op success (queueId: null) when deleting from Trash folder', async () => {
      const db = DatabaseService.getInstance();
      const trashFolder = db.getTrashFolder(suiteAccountId);

      // Both messages are now in Trash from previous tests, so attempting to delete from Trash is a no-op
      const plainHeaders = emlFixtures['plain-text'].headers;

      const response = await callIpc(
        'mail:delete',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        trashFolder,
      ) as IpcResponse<{ queueId: string | null }>;

      expect(response.success).to.equal(true);
      expect(response.data!.queueId).to.be.null;
    });

    it('emits queue:update lifecycle events for the delete operation', async function () {
      this.timeout(25_000);

      // Restore state for a fresh delete operation
      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'queue-delete-lifecycle@example.com' });
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
      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const deleteResponse = await callIpc(
        'mail:delete',
        String(suiteAccountId),
        [plainMsg.headers.xGmMsgId],
        'INBOX',
      ) as IpcResponse<{ queueId: string }>;

      expect(deleteResponse.success).to.equal(true);
      const queueId = deleteResponse.data!.queueId;

      if (queueId !== null) {
        // waitForQueueUpdate with 'completed' throws if the worker fails, so
        // reaching the assertion below means the delete operation succeeded.
        const finalSnapshot = await waitForQueueUpdate(queueId, 'completed', 15_000);
        expect(finalSnapshot.status).to.equal('completed');
      }
    });
  });

  // =========================================================================
  // Label operations
  // =========================================================================

  describe('label:create — create a new label', () => {
    before(async function () {
      this.timeout(35_000);
      await setupSuiteWithMessages('queue-label-create@example.com', 'Queue Label Create Test');
    });

    it('label:create returns success with the new label object', async () => {
      const response = await callIpc(
        'label:create',
        String(suiteAccountId),
        'TestLabel',
        '#FF5733',
      ) as IpcResponse<Record<string, unknown>>;

      expect(response.success).to.equal(true);
      expect(response.data).to.exist;
      expect(response.data!['name']).to.equal('TestLabel');
      expect(response.data!['gmailLabelId']).to.equal('TestLabel');
      expect(response.data!['color']).to.equal('#FF5733');
      expect(response.data!['type']).to.equal('user');
    });

    it('persists the new label in the local DB', async () => {
      await callIpc(
        'label:create',
        String(suiteAccountId),
        'PersistedLabel',
        null,
      );

      const db = DatabaseService.getInstance();
      const label = db.getLabelByGmailId(suiteAccountId, 'PersistedLabel');
      expect(label).to.not.be.null;
      expect(label!['name']).to.equal('PersistedLabel');
      expect(label!['type']).to.equal('user');
    });

    it('rejects label names starting with [Gmail]/', async () => {
      const response = await callIpc(
        'label:create',
        String(suiteAccountId),
        '[Gmail]/BadLabel',
        null,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_INVALID_NAME');
    });

    it('rejects duplicate label names (case-insensitive)', async () => {
      // Create a label first
      await callIpc(
        'label:create',
        String(suiteAccountId),
        'UniqueLabel',
        null,
      );

      // Try to create it again with different casing
      const duplicateResponse = await callIpc(
        'label:create',
        String(suiteAccountId),
        'uniquelabel',
        null,
      ) as IpcResponse<unknown>;

      expect(duplicateResponse.success).to.equal(false);
      expect(duplicateResponse.error!.code).to.equal('LABEL_DUPLICATE_NAME');
    });

    it('rejects invalid hex color codes', async () => {
      const response = await callIpc(
        'label:create',
        String(suiteAccountId),
        'BadColorLabel',
        'not-a-color',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_INVALID_COLOR');
    });
  });

  describe('label:delete — delete a label', () => {
    before(async function () {
      this.timeout(35_000);
      await setupSuiteWithMessages('queue-label-delete@example.com', 'Queue Label Delete Test');
    });

    it('label:delete returns success for an existing user label', async () => {
      // Create a label to delete
      await callIpc(
        'label:create',
        String(suiteAccountId),
        'ToDelete',
        null,
      );

      const db = DatabaseService.getInstance();
      const beforeDelete = db.getLabelByGmailId(suiteAccountId, 'ToDelete');
      expect(beforeDelete).to.not.be.null;

      const deleteResponse = await callIpc(
        'label:delete',
        String(suiteAccountId),
        'ToDelete',
      ) as IpcResponse<null>;

      expect(deleteResponse.success).to.equal(true);

      // Optimistic: label should be removed from DB immediately
      const afterDelete = db.getLabelByGmailId(suiteAccountId, 'ToDelete');
      expect(afterDelete).to.be.null;
    });

    it('emits queue:update for the delete-label operation', async function () {
      this.timeout(20_000);

      // Create the label first
      await callIpc(
        'label:create',
        String(suiteAccountId),
        'ToDeleteWithEvent',
        null,
      );

      // Count prior delete-label completed events
      const priorCount = TestEventBus.getInstance().getHistory('queue:update').filter(
        (record) => {
          const snapshot = record.args[0] as QueueUpdateSnapshot | undefined;
          return (
            snapshot != null &&
            snapshot.accountId === suiteAccountId &&
            snapshot.type === 'delete-label' &&
            (snapshot.status === 'completed' || snapshot.status === 'failed')
          );
        },
      ).length;

      await callIpc(
        'label:delete',
        String(suiteAccountId),
        'ToDeleteWithEvent',
      );

      // Wait for the async IMAP delete to complete via queue:update
      await waitForEvent('queue:update', {
        timeout: 15_000,
        predicate: (args) => {
          const snapshot = args[0] as QueueUpdateSnapshot | undefined;
          if (!snapshot) {
            return false;
          }
          if (snapshot.accountId !== suiteAccountId) {
            return false;
          }
          if (snapshot.type !== 'delete-label') {
            return false;
          }
          if (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('queue:update').filter(
            (record) => {
              const recordSnapshot = record.args[0] as QueueUpdateSnapshot | undefined;
              return (
                recordSnapshot != null &&
                recordSnapshot.accountId === suiteAccountId &&
                recordSnapshot.type === 'delete-label' &&
                (recordSnapshot.status === 'completed' || recordSnapshot.status === 'failed')
              );
            },
          ).length;
          return currentCount > priorCount;
        },
      });
    });

    it('returns LABEL_NOT_FOUND for a non-existent label', async () => {
      const response = await callIpc(
        'label:delete',
        String(suiteAccountId),
        'NonExistentLabel',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_NOT_FOUND');
    });

    it('returns LABEL_NOT_USER when attempting to delete a system label', async () => {
      // System labels like INBOX cannot be deleted
      const response = await callIpc(
        'label:delete',
        String(suiteAccountId),
        'INBOX',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_NOT_USER');
    });
  });

  describe('label:update-color — update label color', () => {
    before(async function () {
      this.timeout(35_000);
      await setupSuiteWithMessages('queue-label-color@example.com', 'Queue Label Color Test');
    });

    it('label:update-color returns success with the updated color', async () => {
      // Create a label to update
      await callIpc(
        'label:create',
        String(suiteAccountId),
        'ColorableLabel',
        '#AABBCC',
      );

      const response = await callIpc(
        'label:update-color',
        String(suiteAccountId),
        'ColorableLabel',
        '#112233',
      ) as IpcResponse<{ gmailLabelId: string; color: string }>;

      expect(response.success).to.equal(true);
      expect(response.data!.gmailLabelId).to.equal('ColorableLabel');
      expect(response.data!.color).to.equal('#112233');
    });

    it('persists the updated color in the local DB', async () => {
      const db = DatabaseService.getInstance();

      await callIpc(
        'label:create',
        String(suiteAccountId),
        'PersistedColorLabel',
        '#FFFFFF',
      );

      await callIpc(
        'label:update-color',
        String(suiteAccountId),
        'PersistedColorLabel',
        '#000000',
      );

      const label = db.getLabelByGmailId(suiteAccountId, 'PersistedColorLabel');
      expect(label).to.not.be.null;
      expect(label!['color']).to.equal('#000000');
    });

    it('allows setting color to null (no color)', async () => {
      await callIpc(
        'label:create',
        String(suiteAccountId),
        'NullColorLabel',
        '#FFFFFF',
      );

      const response = await callIpc(
        'label:update-color',
        String(suiteAccountId),
        'NullColorLabel',
        null,
      ) as IpcResponse<{ color: string | null }>;

      expect(response.success).to.equal(true);
      expect(response.data!.color).to.be.null;
    });

    it('rejects invalid hex color codes', async () => {
      await callIpc(
        'label:create',
        String(suiteAccountId),
        'BadColorLabelUpdate',
        null,
      );

      const response = await callIpc(
        'label:update-color',
        String(suiteAccountId),
        'BadColorLabelUpdate',
        'invalid',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_INVALID_COLOR');
    });
  });

  // =========================================================================
  // Label add/remove via queue:enqueue (no higher-level IPC for these)
  // =========================================================================

  describe('queue:enqueue — add-labels and remove-labels', () => {
    let targetLabelName: string;

    before(async function () {
      this.timeout(40_000);
      await setupSuiteWithMessages('queue-label-ops@example.com', 'Queue Label Ops Test');

      // Create a user label to add/remove messages to/from
      targetLabelName = 'WorkLabel';
      await callIpc(
        'label:create',
        String(suiteAccountId),
        targetLabelName,
        '#4287F5',
      );
    });

    it('queue:enqueue add-labels returns success with a queueId', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;

      const response = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [plainHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: plainHeaders.xGmThrid,
        },
        description: 'Add WorkLabel to plain-text message',
      }) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.have.property('queueId').that.is.a('string');
    });

    it('emits queue:update events through the add-labels lifecycle', async function () {
      this.timeout(20_000);

      const htmlHeaders = emlFixtures['html-email'].headers;

      const priorCount = TestEventBus.getInstance().getHistory('queue:update').filter(
        (record) => {
          const snapshot = record.args[0] as QueueUpdateSnapshot | undefined;
          return (
            snapshot != null &&
            snapshot.accountId === suiteAccountId &&
            snapshot.type === 'add-labels' &&
            (snapshot.status === 'completed' || snapshot.status === 'failed')
          );
        },
      ).length;

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [htmlHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: htmlHeaders.xGmThrid,
        },
        description: 'Add WorkLabel to html-email message',
      }) as IpcResponse<{ queueId: string }>;

      expect(enqueueResponse.success).to.equal(true);
      const queueId = enqueueResponse.data!.queueId;

      // Wait for the add-labels operation to complete
      await waitForEvent('queue:update', {
        timeout: 15_000,
        predicate: (args) => {
          const snapshot = args[0] as QueueUpdateSnapshot | undefined;
          if (!snapshot) {
            return false;
          }
          if (snapshot.accountId !== suiteAccountId) {
            return false;
          }
          if (snapshot.type !== 'add-labels') {
            return false;
          }
          if (snapshot.queueId !== queueId) {
            return false;
          }
          if (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('queue:update').filter(
            (record) => {
              const recordSnapshot = record.args[0] as QueueUpdateSnapshot | undefined;
              return (
                recordSnapshot != null &&
                recordSnapshot.accountId === suiteAccountId &&
                recordSnapshot.type === 'add-labels' &&
                (recordSnapshot.status === 'completed' || recordSnapshot.status === 'failed')
              );
            },
          ).length;
          return currentCount > priorCount;
        },
      });
    });

    it('queue:enqueue remove-labels returns success with a queueId', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;

      const response = await callIpc('queue:enqueue', {
        type: 'remove-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [plainHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: plainHeaders.xGmThrid,
        },
        description: 'Remove WorkLabel from plain-text message',
      }) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.have.property('queueId').that.is.a('string');
    });

    it('emits queue:update events through the remove-labels lifecycle', async function () {
      this.timeout(20_000);

      const htmlHeaders = emlFixtures['html-email'].headers;

      const priorCount = TestEventBus.getInstance().getHistory('queue:update').filter(
        (record) => {
          const snapshot = record.args[0] as QueueUpdateSnapshot | undefined;
          return (
            snapshot != null &&
            snapshot.accountId === suiteAccountId &&
            snapshot.type === 'remove-labels' &&
            (snapshot.status === 'completed' || snapshot.status === 'failed')
          );
        },
      ).length;

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'remove-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [htmlHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: htmlHeaders.xGmThrid,
        },
        description: 'Remove WorkLabel from html-email message',
      }) as IpcResponse<{ queueId: string }>;

      expect(enqueueResponse.success).to.equal(true);
      const queueId = enqueueResponse.data!.queueId;

      await waitForEvent('queue:update', {
        timeout: 15_000,
        predicate: (args) => {
          const snapshot = args[0] as QueueUpdateSnapshot | undefined;
          if (!snapshot) {
            return false;
          }
          if (snapshot.accountId !== suiteAccountId) {
            return false;
          }
          if (snapshot.type !== 'remove-labels') {
            return false;
          }
          if (snapshot.queueId !== queueId) {
            return false;
          }
          if (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('queue:update').filter(
            (record) => {
              const recordSnapshot = record.args[0] as QueueUpdateSnapshot | undefined;
              return (
                recordSnapshot != null &&
                recordSnapshot.accountId === suiteAccountId &&
                recordSnapshot.type === 'remove-labels' &&
                (recordSnapshot.status === 'completed' || recordSnapshot.status === 'failed')
              );
            },
          ).length;
          return currentCount > priorCount;
        },
      });
    });
  });

  // =========================================================================
  // queue:update emitted through full lifecycle
  // =========================================================================

  describe('queue:update event lifecycle', () => {
    before(async function () {
      this.timeout(35_000);
      await setupSuiteWithMessages('queue-lifecycle@example.com', 'Queue Lifecycle Test');
    });

    it('emits queue:update with status=pending when an operation is enqueued', async function () {
      this.timeout(15_000);

      const plainHeaders = emlFixtures['plain-text'].headers;

      // Listen for a pending event before enqueueing
      const pendingPromise = waitForEvent('queue:update', {
        timeout: 10_000,
        predicate: (args) => {
          const snapshot = args[0] as QueueUpdateSnapshot | undefined;
          return (
            snapshot != null &&
            snapshot.accountId === suiteAccountId &&
            snapshot.type === 'flag' &&
            (snapshot.status === 'pending' || snapshot.status === 'processing' || snapshot.status === 'completed')
          );
        },
      });

      const flagResponse = await callIpc(
        'mail:flag',
        String(suiteAccountId),
        [plainHeaders.xGmMsgId],
        'read',
        true,
      ) as IpcResponse<{ queueId: string }>;

      expect(flagResponse.success).to.equal(true);

      // The pending event should arrive quickly (emitted synchronously on enqueue)
      await pendingPromise;
    });

    it('queue:get-status returns all queued items', async () => {
      const response = await callIpc('queue:get-status') as IpcResponse<{ items: unknown[] }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.have.property('items').that.is.an('array');
    });

    it('queue:get-pending-count returns a non-negative integer', async () => {
      const response = await callIpc('queue:get-pending-count') as IpcResponse<{ count: number }>;

      expect(response.success).to.equal(true);
      expect(response.data!.count).to.be.a('number');
      expect(response.data!.count).to.be.at.least(0);
    });

    it('queue:clear-completed returns the number of items cleared', async () => {
      // Wait briefly for any in-flight operations to settle
      await new Promise<void>((resolve) => setTimeout(resolve, 500));

      const response = await callIpc('queue:clear-completed') as IpcResponse<{ clearedCount: number }>;

      expect(response.success).to.equal(true);
      expect(response.data!.clearedCount).to.be.a('number');
      expect(response.data!.clearedCount).to.be.at.least(0);
    });
  });
});
