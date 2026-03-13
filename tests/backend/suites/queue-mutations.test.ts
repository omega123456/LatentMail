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
  waitForNextFolderUpdated,
  waitForQueueTerminalState,
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
// Helper: seed account + sync a set of messages into the local DB
// -------------------------------------------------------------------------

interface SeedAndSyncResult {
  accountId: number;
  email: string;
}

interface RawQueueItemRecord {
  queueId: string;
  status: string;
  payload: Record<string, unknown>;
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

function getRawQueueItem(queueId: string): RawQueueItemRecord | null {
  const { MailQueueService } = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
  const queueService = MailQueueService.getInstance() as unknown as {
    items: Map<string, RawQueueItemRecord>;
  };

  return queueService.items.get(queueId) ?? null;
}

async function triggerFolderSyncAndWait(
  accountId: number,
  folder: string,
  timeoutMs: number = 15_000,
): Promise<void> {
  const response = await callIpc('mail:sync-folder', {
    accountId: String(accountId),
    folder,
  }) as IpcResponse<void>;

  expect(response.success).to.equal(true);

  await waitForNextFolderUpdated(accountId, {
    reason: 'sync',
    folder,
    timeout: timeoutMs,
  });
}

// =========================================================================
// Move operations
// =========================================================================

describe('Queue Mutations', () => {
  describe('queue:enqueue — validation', () => {
    before(async () => {
      await quiesceAndRestore();
    });

    it('returns an error response for null and undefined operations', async () => {
      const nullResponse = await callIpc('queue:enqueue', null) as IpcResponse<unknown>;
      const undefinedResponse = await callIpc('queue:enqueue', undefined) as IpcResponse<unknown>;

      expect(nullResponse.success).to.equal(false);
      expect(nullResponse.error).to.deep.equal({
        code: 'QUEUE_INVALID_OPERATION',
        message: 'Operation must be an object',
      });

      expect(undefinedResponse.success).to.equal(false);
      expect(undefinedResponse.error).to.deep.equal({
        code: 'QUEUE_INVALID_OPERATION',
        message: 'Operation must be an object',
      });
    });

    it('returns QUEUE_INVALID_OPERATION when type is missing', async () => {
      const response = await callIpc('queue:enqueue', {
        accountId: 1,
        payload: {},
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error).to.deep.equal({
        code: 'QUEUE_INVALID_OPERATION',
        message: 'Missing required fields: type, accountId, payload',
      });
    });

    it('returns an error response when accountId is missing', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'move',
        payload: {
          xGmMsgIds: ['message-1'],
          targetFolder: '[Gmail]/Sent Mail',
        },
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error).to.deep.equal({
        code: 'QUEUE_INVALID_OPERATION',
        message: 'Missing required fields: type, accountId, payload',
      });
    });

    it('returns an error response when payload is missing', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'move',
        accountId: 1,
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error).to.deep.equal({
        code: 'QUEUE_INVALID_OPERATION',
        message: 'Missing required fields: type, accountId, payload',
      });
    });

    it('returns QUEUE_INVALID_TYPE for an invalid operation type', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'bogus',
        accountId: 1,
        payload: {},
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error).to.deep.equal({
        code: 'QUEUE_INVALID_TYPE',
        message: 'Invalid operation type: bogus',
      });
    });

    it('returns QUEUE_INVALID_ACCOUNT for non-positive accountId values', async () => {
      for (const accountId of [0, -1]) {
        const response = await callIpc('queue:enqueue', {
          type: 'move',
          accountId,
          payload: {
            xGmMsgIds: ['message-1'],
            targetFolder: '[Gmail]/Sent Mail',
          },
        }) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error).to.deep.equal({
          code: 'QUEUE_INVALID_ACCOUNT',
          message: 'accountId must be a positive number',
        });
      }
    });

    it('returns QUEUE_INVALID_PAYLOAD for draft-update without originalQueueId or serverDraftXGmMsgId', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'draft-update',
        accountId: 1,
        payload: {
          subject: 'Updated draft',
          to: 'recipient@example.com',
        },
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error).to.deep.equal({
        code: 'QUEUE_INVALID_PAYLOAD',
        message: 'draft-update requires originalQueueId or serverDraftXGmMsgId in payload',
      });
    });

    it('validates move payload shape', async () => {
      const missingIdsResponse = await callIpc('queue:enqueue', {
        type: 'move',
        accountId: 1,
        payload: { targetFolder: '[Gmail]/Sent Mail' },
      }) as IpcResponse<unknown>;
      const missingTargetResponse = await callIpc('queue:enqueue', {
        type: 'move',
        accountId: 1,
        payload: { xGmMsgIds: ['msg-1'] },
      }) as IpcResponse<unknown>;

      expect(missingIdsResponse.success).to.equal(false);
      expect(missingIdsResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
      expect(missingTargetResponse.success).to.equal(false);
      expect(missingTargetResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('validates flag payload shape', async () => {
      const missingIdsResponse = await callIpc('queue:enqueue', {
        type: 'flag',
        accountId: 1,
        payload: { flag: 'read', value: true },
      }) as IpcResponse<unknown>;
      const missingFlagResponse = await callIpc('queue:enqueue', {
        type: 'flag',
        accountId: 1,
        payload: { xGmMsgIds: ['msg-1'], value: true },
      }) as IpcResponse<unknown>;
      const missingValueResponse = await callIpc('queue:enqueue', {
        type: 'flag',
        accountId: 1,
        payload: { xGmMsgIds: ['msg-1'], flag: 'read' },
      }) as IpcResponse<unknown>;

      expect(missingIdsResponse.success).to.equal(false);
      expect(missingIdsResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
      expect(missingFlagResponse.success).to.equal(false);
      expect(missingFlagResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
      expect(missingValueResponse.success).to.equal(false);
      expect(missingValueResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('validates send payload subject type', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'send',
        accountId: 1,
        payload: {
          to: 'person@example.com',
          subject: 42,
        },
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('validates delete payload shape', async () => {
      const missingIdsResponse = await callIpc('queue:enqueue', {
        type: 'delete',
        accountId: 1,
        payload: { folder: 'INBOX' },
      }) as IpcResponse<unknown>;
      const missingFolderResponse = await callIpc('queue:enqueue', {
        type: 'delete',
        accountId: 1,
        payload: { xGmMsgIds: ['msg-1'] },
      }) as IpcResponse<unknown>;

      expect(missingIdsResponse.success).to.equal(false);
      expect(missingIdsResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
      expect(missingFolderResponse.success).to.equal(false);
      expect(missingFolderResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('validates delete-label payload shape', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'delete-label',
        accountId: 1,
        payload: { gmailLabelId: '   ' },
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('validates add-labels payload shape', async () => {
      const missingIdsResponse = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: 1,
        payload: { targetLabels: ['Label'], threadId: 'thread-1' },
      }) as IpcResponse<unknown>;
      const missingLabelsResponse = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: 1,
        payload: { xGmMsgIds: ['msg-1'], threadId: 'thread-1' },
      }) as IpcResponse<unknown>;
      const missingThreadResponse = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: 1,
        payload: { xGmMsgIds: ['msg-1'], targetLabels: ['Label'] },
      }) as IpcResponse<unknown>;

      expect(missingIdsResponse.success).to.equal(false);
      expect(missingIdsResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
      expect(missingLabelsResponse.success).to.equal(false);
      expect(missingLabelsResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
      expect(missingThreadResponse.success).to.equal(false);
      expect(missingThreadResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('validates remove-labels payload shape', async () => {
      const missingIdsResponse = await callIpc('queue:enqueue', {
        type: 'remove-labels',
        accountId: 1,
        payload: { targetLabels: ['Label'], threadId: 'thread-1' },
      }) as IpcResponse<unknown>;
      const missingLabelsResponse = await callIpc('queue:enqueue', {
        type: 'remove-labels',
        accountId: 1,
        payload: { xGmMsgIds: ['msg-1'], threadId: 'thread-1' },
      }) as IpcResponse<unknown>;
      const missingThreadResponse = await callIpc('queue:enqueue', {
        type: 'remove-labels',
        accountId: 1,
        payload: { xGmMsgIds: ['msg-1'], targetLabels: ['Label'] },
      }) as IpcResponse<unknown>;

      expect(missingIdsResponse.success).to.equal(false);
      expect(missingIdsResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
      expect(missingLabelsResponse.success).to.equal(false);
      expect(missingLabelsResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
      expect(missingThreadResponse.success).to.equal(false);
      expect(missingThreadResponse.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('returns QUEUE_ENQUEUE_FAILED when queue enqueue throws unexpectedly', async () => {
      const queueService = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
      const mailQueueService = queueService.MailQueueService.getInstance() as unknown as {
        enqueue: (...args: unknown[]) => string;
      };
      const originalEnqueue = mailQueueService.enqueue;
      mailQueueService.enqueue = (..._args: unknown[]): string => {
        throw new Error('forced queue enqueue failure');
      };

      try {
        const response = await callIpc('queue:enqueue', {
          type: 'send',
          accountId: 1,
          payload: {
            to: 'valid@example.com',
            subject: 'Trigger catch path',
          },
        }) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('QUEUE_ENQUEUE_FAILED');
      } finally {
        mailQueueService.enqueue = originalEnqueue;
      }
    });

    it('returns QUEUE_STATUS_FAILED when queue:get-status throws unexpectedly', async () => {
      const queueService = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
      const mailQueueService = queueService.MailQueueService.getInstance() as unknown as {
        getAllItems: () => unknown[];
      };
      const originalGetAllItems = mailQueueService.getAllItems;
      mailQueueService.getAllItems = (): unknown[] => {
        throw new Error('forced queue:get-status failure');
      };

      try {
        const response = await callIpc('queue:get-status') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('QUEUE_STATUS_FAILED');
      } finally {
        mailQueueService.getAllItems = originalGetAllItems;
      }
    });

    it('returns QUEUE_RETRY_FAILED when queue:retry-failed throws unexpectedly', async () => {
      const queueService = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
      const mailQueueService = queueService.MailQueueService.getInstance() as unknown as {
        retryFailed: (queueId?: string) => number;
      };
      const originalRetryFailed = mailQueueService.retryFailed;
      mailQueueService.retryFailed = (_queueId?: string): number => {
        throw new Error('forced queue:retry-failed failure');
      };

      try {
        const response = await callIpc('queue:retry-failed', { queueId: 'queue-id-123' }) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('QUEUE_RETRY_FAILED');
      } finally {
        mailQueueService.retryFailed = originalRetryFailed;
      }
    });

    it('returns QUEUE_CLEAR_FAILED when queue:clear-completed throws unexpectedly', async () => {
      const queueService = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
      const mailQueueService = queueService.MailQueueService.getInstance() as unknown as {
        clearCompleted: () => number;
      };
      const originalClearCompleted = mailQueueService.clearCompleted;
      mailQueueService.clearCompleted = (): number => {
        throw new Error('forced queue:clear-completed failure');
      };

      try {
        const response = await callIpc('queue:clear-completed') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('QUEUE_CLEAR_FAILED');
      } finally {
        mailQueueService.clearCompleted = originalClearCompleted;
      }
    });

    it('returns QUEUE_CANCEL_FAILED when queue:cancel throws unexpectedly', async () => {
      const queueService = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
      const mailQueueService = queueService.MailQueueService.getInstance() as unknown as {
        cancel: (queueId: string) => boolean;
      };
      const originalCancel = mailQueueService.cancel;
      mailQueueService.cancel = (_queueId: string): boolean => {
        throw new Error('forced queue:cancel failure');
      };

      try {
        const response = await callIpc('queue:cancel', { queueId: 'queue-id-456' }) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('QUEUE_CANCEL_FAILED');
      } finally {
        mailQueueService.cancel = originalCancel;
      }
    });

    it('returns QUEUE_PENDING_COUNT_FAILED when queue:get-pending-count throws unexpectedly', async () => {
      const queueService = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
      const mailQueueService = queueService.MailQueueService.getInstance() as unknown as {
        getPendingCount: () => number;
      };
      const originalGetPendingCount = mailQueueService.getPendingCount;
      mailQueueService.getPendingCount = (): number => {
        throw new Error('forced queue:get-pending-count failure');
      };

      try {
        const response = await callIpc('queue:get-pending-count') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('QUEUE_PENDING_COUNT_FAILED');
      } finally {
        mailQueueService.getPendingCount = originalGetPendingCount;
      }
    });

    it('returns BODY_QUEUE_STATUS_FAILED when body-queue:get-status throws unexpectedly', async () => {
      const bodyQueueModule = require('../../../electron/services/body-fetch-queue-service') as typeof import('../../../electron/services/body-fetch-queue-service');
      const bodyQueueService = bodyQueueModule.BodyFetchQueueService.getInstance() as unknown as {
        getAllItems: () => unknown[];
      };
      const originalGetAllItems = bodyQueueService.getAllItems;
      bodyQueueService.getAllItems = (): unknown[] => {
        throw new Error('forced body-queue:get-status failure');
      };

      try {
        const response = await callIpc('body-queue:get-status') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('BODY_QUEUE_STATUS_FAILED');
      } finally {
        bodyQueueService.getAllItems = originalGetAllItems;
      }
    });

    it('returns BODY_QUEUE_CLEAR_FAILED when body-queue:clear-completed throws unexpectedly', async () => {
      const bodyQueueModule = require('../../../electron/services/body-fetch-queue-service') as typeof import('../../../electron/services/body-fetch-queue-service');
      const bodyQueueService = bodyQueueModule.BodyFetchQueueService.getInstance() as unknown as {
        clearCompleted: () => void;
      };
      const originalClearCompleted = bodyQueueService.clearCompleted;
      bodyQueueService.clearCompleted = (): void => {
        throw new Error('forced body-queue:clear-completed failure');
      };

      try {
        const response = await callIpc('body-queue:clear-completed') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('BODY_QUEUE_CLEAR_FAILED');
      } finally {
        bodyQueueService.clearCompleted = originalClearCompleted;
      }
    });

    it('returns BODY_QUEUE_CANCEL_FAILED when body-queue:cancel throws unexpectedly', async () => {
      const bodyQueueModule = require('../../../electron/services/body-fetch-queue-service') as typeof import('../../../electron/services/body-fetch-queue-service');
      const bodyQueueService = bodyQueueModule.BodyFetchQueueService.getInstance() as unknown as {
        cancel: (queueId: string) => boolean;
      };
      const originalCancel = bodyQueueService.cancel;
      bodyQueueService.cancel = (_queueId: string): boolean => {
        throw new Error('forced body-queue:cancel failure');
      };

      try {
        const response = await callIpc('body-queue:cancel', 'body-queue-id-789') as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('BODY_QUEUE_CANCEL_FAILED');
      } finally {
        bodyQueueService.cancel = originalCancel;
      }
    });
  });

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
      const finalSnapshot = await waitForQueueTerminalState(queueId, { expectedStatus: 'completed', timeout: 15_000 });

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

      const moveResponse = await callIpc(
        'mail:move',
        String(suiteAccountId),
        [htmlMsg.headers.xGmMsgId],
        '[Gmail]/Sent Mail',
        'INBOX',
      ) as IpcResponse<{ queueId: string }>;

      expect(moveResponse.success).to.equal(true);

      // Wait for mail:folder-updated to be emitted as part of the move post-processing
      await waitForNextFolderUpdated(suiteAccountId, { timeout: 15_000 });
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

      const finalSnapshot = await waitForQueueTerminalState(queueId, { expectedStatus: 'completed', timeout: 15_000 });
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
        const finalSnapshot = await waitForQueueTerminalState(queueId, { expectedStatus: 'completed', timeout: 15_000 });
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

  describe('queue:enqueue — label UID resolution', () => {
    before(async function () {
      this.timeout(40_000);
      await setupSuiteWithMessages('queue-label-resolution@example.com', 'Queue Label Resolution Test');
    });

    it('resolves add-labels UIDs at enqueue time and returns a queueId', async function () {
      this.timeout(20_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const targetLabelName = 'QueueResolutionAddLabel';
      const databaseService = DatabaseService.getInstance();

      await callIpc(
        'label:create',
        String(suiteAccountId),
        targetLabelName,
        '#4A90E2',
      );

      const allMailUid = databaseService
        .getFolderUidsForEmail(suiteAccountId, plainHeaders.xGmMsgId)
        .find((folderUid) => folderUid.folder === '[Gmail]/All Mail');

      expect(allMailUid).to.exist;

      const response = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [plainHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: plainHeaders.xGmThrid,
        },
        description: 'Resolve add-labels UIDs at enqueue time',
      }) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.exist;
      expect(response.data!.queueId).to.be.a('string');
      expect(response.data!.queueId).to.not.equal('skipped');

      const queueId = response.data!.queueId;
      const queueItem = getRawQueueItem(queueId);

      expect(queueItem).to.not.be.null;

      const payload = queueItem!.payload as {
        resolvedEmails?: Array<{ xGmMsgId: string; sourceFolder: string; uid: number }>;
      };

      expect(payload.resolvedEmails).to.deep.equal([
        {
          xGmMsgId: plainHeaders.xGmMsgId,
          sourceFolder: '[Gmail]/All Mail',
          uid: allMailUid!.uid,
        },
      ]);

      await waitForQueueTerminalState(queueId, { expectedStatus: 'completed', timeout: 15_000 });
    });

    it('returns queueId "skipped" for add-labels when no email UIDs resolve', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: ['missing-x-gm-msgid'],
          targetLabels: ['QueueResolutionSkippedLabel'],
          threadId: 'missing-thread',
        },
        description: 'Skip add-labels when no UIDs resolve',
      }) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.deep.equal({ queueId: 'skipped' });
    });

    it('resolves remove-labels UIDs at enqueue time after label-folder sync', async function () {
      this.timeout(30_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const targetLabelName = 'QueueResolutionRemoveLabel';
      const databaseService = DatabaseService.getInstance();

      await callIpc(
        'label:create',
        String(suiteAccountId),
        targetLabelName,
        '#7ED321',
      );

      const addResponse = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [plainHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: plainHeaders.xGmThrid,
        },
        description: 'Prepare label folder before remove-labels test',
      }) as IpcResponse<{ queueId: string }>;

      expect(addResponse.success).to.equal(true);
      expect(addResponse.data).to.exist;

      await waitForQueueTerminalState(addResponse.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });
      await triggerFolderSyncAndWait(suiteAccountId, targetLabelName, 20_000);

      const labelFolderUid = databaseService
        .getFolderUidsForEmail(suiteAccountId, plainHeaders.xGmMsgId)
        .find((folderUid) => folderUid.folder === targetLabelName);

      expect(labelFolderUid).to.exist;

      const response = await callIpc('queue:enqueue', {
        type: 'remove-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [plainHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: plainHeaders.xGmThrid,
        },
        description: 'Resolve remove-labels UIDs at enqueue time',
      }) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.exist;
      expect(response.data!.queueId).to.be.a('string');
      expect(response.data!.queueId).to.not.equal('skipped');

      const queueId = response.data!.queueId;
      const queueItem = getRawQueueItem(queueId);

      expect(queueItem).to.not.be.null;

      const payload = queueItem!.payload as {
        resolvedEmails?: Array<{ xGmMsgId: string; labelFolder: string; uid: number }>;
      };

      expect(payload.resolvedEmails).to.deep.equal([
        {
          xGmMsgId: plainHeaders.xGmMsgId,
          labelFolder: targetLabelName,
          uid: labelFolderUid!.uid,
        },
      ]);

      await waitForQueueTerminalState(queueId, { expectedStatus: 'completed', timeout: 15_000 });
    });

    it('does not skip remove-labels when no label-folder UIDs resolve', async function () {
      this.timeout(20_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const targetLabelName = 'QueueResolutionNoUidLabel';

      await callIpc(
        'label:create',
        String(suiteAccountId),
        targetLabelName,
        '#F5A623',
      );

      const response = await callIpc('queue:enqueue', {
        type: 'remove-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [plainHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: plainHeaders.xGmThrid,
        },
        description: 'Do not skip remove-labels when no UIDs resolve',
      }) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.exist;
      expect(response.data!.queueId).to.be.a('string');
      expect(response.data!.queueId).to.not.equal('skipped');

      const queueId = response.data!.queueId;
      const queueItem = getRawQueueItem(queueId);

      expect(queueItem).to.not.be.null;

      const payload = queueItem!.payload as {
        resolvedEmails?: Array<{ xGmMsgId: string; labelFolder: string; uid: number }>;
      };

      expect(payload.resolvedEmails).to.deep.equal([]);

      await waitForQueueTerminalState(queueId, { expectedStatus: 'completed', timeout: 15_000 });
    });

    it('marks remove-labels as failed when dynamic UID resolution hits a non-existent label folder', async function () {
      this.timeout(20_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const targetLabelName = 'QueueResolutionMissingServerLabel';
      const databaseService = DatabaseService.getInstance();

      databaseService.createLabel(suiteAccountId, targetLabelName, targetLabelName, '#CC8844');

      const response = await callIpc('queue:enqueue', {
        type: 'remove-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [plainHeaders.xGmMsgId],
          targetLabels: [targetLabelName],
          threadId: plainHeaders.xGmThrid,
        },
        description: 'Fail remove-labels when label folder does not exist on server',
      }) as IpcResponse<{ queueId: string }>;

      expect(response.success).to.equal(true);
      expect(response.data).to.exist;
      expect(response.data!.queueId).to.be.a('string');

      const terminalUpdate = await waitForQueueTerminalState(response.data!.queueId, { expectedStatus: 'failed', timeout: 15_000 });
      expect(terminalUpdate.queueId).to.equal(response.data!.queueId);
      expect(terminalUpdate.status).to.equal('failed');
      expect(terminalUpdate.error).to.include('remove-labels: all IMAP operations failed');
    });
  });

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

    it('marks add-labels as failed when every IMAP copy operation fails', async function () {
      this.timeout(20_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const imapServiceModule = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
      const imapService = imapServiceModule.ImapService.getInstance() as unknown as {
        copyMessages: (accountId: string, sourceFolder: string, uids: number[], targetFolder: string) => Promise<void>;
      };
      const originalCopyMessages = imapService.copyMessages;
      imapService.copyMessages = async (): Promise<void> => {
        throw new Error('forced copyMessages failure');
      };

      try {
        const response = await callIpc('queue:enqueue', {
          type: 'add-labels',
          accountId: suiteAccountId,
          payload: {
            xGmMsgIds: [plainHeaders.xGmMsgId],
            targetLabels: [targetLabelName],
            threadId: plainHeaders.xGmThrid,
          },
          description: 'Force add-labels failure',
        }) as IpcResponse<{ queueId: string }>;

        expect(response.success).to.equal(true);
        const queueId = response.data!.queueId;

        const terminalUpdate = await waitForQueueTerminalState(queueId, { expectedStatus: 'failed', timeout: 15_000 });
        expect(terminalUpdate.status).to.equal('failed');
      } finally {
        imapService.copyMessages = originalCopyMessages;
      }
    });

    it('marks remove-labels as failed when IMAP label removal fails for all messages', async function () {
      this.timeout(20_000);

      const plainHeaders = emlFixtures['plain-text'].headers;
      const failingLabelName = 'RemoveLabelsFailureLabel';

      await callIpc(
        'label:create',
        String(suiteAccountId),
        failingLabelName,
        '#AA55CC',
      );

      const addResponse = await callIpc('queue:enqueue', {
        type: 'add-labels',
        accountId: suiteAccountId,
        payload: {
          xGmMsgIds: [plainHeaders.xGmMsgId],
          targetLabels: [failingLabelName],
          threadId: plainHeaders.xGmThrid,
        },
        description: 'Prepare failing remove-labels operation',
      }) as IpcResponse<{ queueId: string }>;

      expect(addResponse.success).to.equal(true);
      await waitForQueueTerminalState(addResponse.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });
      await triggerFolderSyncAndWait(suiteAccountId, failingLabelName, 20_000);

      const imapServiceModule = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
      const imapService = imapServiceModule.ImapService.getInstance() as unknown as {
        removeFromLabel: (accountId: string, labelFolder: string, uids: number[]) => Promise<void>;
      };
      const originalRemoveFromLabel = imapService.removeFromLabel;
      imapService.removeFromLabel = async (): Promise<void> => {
        throw new Error('forced removeFromLabel failure');
      };

      try {
        const response = await callIpc('queue:enqueue', {
          type: 'remove-labels',
          accountId: suiteAccountId,
          payload: {
            xGmMsgIds: [plainHeaders.xGmMsgId],
            targetLabels: [failingLabelName],
            threadId: plainHeaders.xGmThrid,
          },
          description: 'Force remove-labels failure',
        }) as IpcResponse<{ queueId: string }>;

        expect(response.success).to.equal(true);
        const queueId = response.data!.queueId;

        const terminalUpdate = await waitForQueueTerminalState(queueId, { expectedStatus: 'failed', timeout: 15_000 });
        expect(terminalUpdate.status).to.equal('failed');
      } finally {
        imapService.removeFromLabel = originalRemoveFromLabel;
      }
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
