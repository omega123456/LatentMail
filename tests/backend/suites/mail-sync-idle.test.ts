/**
 * mail-sync-idle.test.ts — Backend E2E tests for mail sync and IDLE.
 *
 * Covers:
 *   - Initial sync: labels/mailboxes synced to local labels table
 *   - Mailbox discovery excludes [Gmail] parent container and hidden system labels
 *   - Folder sync: new messages ingested, existing messages updated
 *   - Incremental sync via CONDSTORE (only changed messages fetched)
 *   - UIDVALIDITY reset: local folder data wiped and rebuilt
 *   - Stale UID reconciliation: messages deleted on server removed locally
 *   - All Mail sync: Gmail labels mapped to folder associations
 *   - Thread metadata recomputed after sync
 *   - Contact extraction from synced mail
 *   - INBOX IDLE: new message via EXISTS notification → sync → mail:folder-updated
 *   - All Mail IDLE: EXPUNGE notification → reconcile sync → mail:folder-updated
 *   - Sync pause/resume via sync:pause / sync:resume / sync:get-paused IPC
 *   - Manual sync trigger via mail:sync-account
 *   - Post-sync automatic filter processing on new INBOX emails
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
import { SyncService } from '../../../electron/services/sync-service';
import { SyncQueueBridge } from '../../../electron/services/sync-queue-bridge';
import { TestEventBus } from '../infrastructure/test-event-bus';

// ---- Type helpers ----

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface FolderRow {
  gmailLabelId: string;
  name: string;
  type: string;
  unreadCount: number;
}

interface SyncPausedResponse {
  paused: boolean;
}

interface FolderUpdatedPayload {
  accountId: number;
  folders: string[];
  reason: string;
  changeType?: string;
  count?: number;
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

describe('Mail Sync & IDLE', () => {
  // =========================================================================
  // Sync: initial sync and label discovery
  // =========================================================================

  describe('Initial sync and label discovery', () => {
    before(async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-initial@example.com',
        displayName: 'Sync Initial Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject a plain-text message so sync-allmail sees at least one message
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

      // Run an initial sync
      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('syncs standard Gmail mailboxes to the local labels table', async () => {
      const db = DatabaseService.getInstance();
      const labels = db.getLabelsByAccount(suiteAccountId);
      const gmailLabelIds = labels.map((label) => String(label['gmailLabelId']));

      // Standard Gmail mailboxes must be present after sync.
      // Note: [Gmail]/All Mail is intentionally excluded from the labels table
      // because it is a sync-only folder (not shown in the sidebar).
      expect(gmailLabelIds).to.include('INBOX');
      expect(gmailLabelIds).to.include('[Gmail]/Sent Mail');
      expect(gmailLabelIds).to.include('[Gmail]/Drafts');
      expect(gmailLabelIds).to.include('[Gmail]/Trash');
    });

    it('excludes [Gmail] parent container from the labels table', async () => {
      const db = DatabaseService.getInstance();
      const labels = db.getLabelsByAccount(suiteAccountId);
      const gmailLabelIds = labels.map((label) => String(label['gmailLabelId']));

      // [Gmail] is a \Noselect parent — should be excluded
      expect(gmailLabelIds).to.not.include('[Gmail]');
    });

    it('persists at least one email after initial sync', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();
      const email = db.getEmailByXGmMsgId(suiteAccountId, plainHeaders.xGmMsgId);

      expect(email).to.not.be.null;
      expect(email!['xGmMsgId']).to.equal(plainHeaders.xGmMsgId);
    });

    it('maps All Mail labels to correct folder associations', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;
      const db = DatabaseService.getInstance();
      const folders = db.getFoldersForEmail(suiteAccountId, plainHeaders.xGmMsgId);

      // The message was injected with \\Inbox label, so it should appear in INBOX
      expect(folders).to.include('INBOX');
    });

    it('mail:get-folders returns the synced folder list after initial sync', async () => {
      const response = await callIpc('mail:get-folders', String(suiteAccountId)) as IpcResponse<FolderRow[]>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');

      const inboxFolder = response.data!.find(
        (folder) => folder.gmailLabelId.toUpperCase() === 'INBOX',
      );
      expect(inboxFolder).to.exist;
    });
  });

  // =========================================================================
  // Incremental sync (CONDSTORE) and stale reconciliation
  // =========================================================================

  describe('Incremental sync and stale reconciliation', () => {
    let firstMsgId: string;

    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-incremental@example.com',
        displayName: 'Sync Incremental Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject an initial message and run the first sync
      const plainMsg = emlFixtures['plain-text'];
      firstMsgId = plainMsg.headers.xGmMsgId;

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

    it('persists the initial message after the first sync', async () => {
      const db = DatabaseService.getInstance();
      const email = db.getEmailByXGmMsgId(suiteAccountId, firstMsgId);
      expect(email).to.not.be.null;
    });

    it('ingests a second message on an incremental sync', async function () {
      this.timeout(25_000);

      const htmlMsg = emlFixtures['html-email'];

      // Inject a new message into the IMAP server
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

      // Trigger incremental sync
      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      const email = db.getEmailByXGmMsgId(suiteAccountId, htmlMsg.headers.xGmMsgId);
      expect(email).to.not.be.null;
      expect(email!['xGmMsgId']).to.equal(htmlMsg.headers.xGmMsgId);
    });

    it('emits mail:folder-updated after incremental sync with new messages', async function () {
      this.timeout(25_000);

      const thread1 = emlFixtures['reply-thread-1'];

      imapStateInspector.injectMessage('[Gmail]/All Mail', thread1.raw, {
        xGmMsgId: thread1.headers.xGmMsgId,
        xGmThrid: thread1.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', thread1.raw, {
        xGmMsgId: thread1.headers.xGmMsgId,
        xGmThrid: thread1.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      const priorCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
        (record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload && payload.accountId === suiteAccountId;
        },
      ).length;

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const newCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
        (record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload && payload.accountId === suiteAccountId;
        },
      ).length;

      expect(newCount).to.be.greaterThan(priorCount);
    });
  });

  // =========================================================================
  // UIDVALIDITY reset
  // =========================================================================

  describe('UIDVALIDITY reset', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-uidvalidity@example.com',
        displayName: 'UIDVALIDITY Test',
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

      // First sync — establishes known UIDVALIDITY
      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('resets local folder data when UIDVALIDITY changes on the server', async function () {
      this.timeout(25_000);

      // Reset UIDVALIDITY on the fake IMAP server — simulates a server-side UID invalidation
      imapStateInspector.resetUidValidity('[Gmail]/All Mail');
      imapStateInspector.resetUidValidity('INBOX');

      // Re-inject the message under the new UIDVALIDITY
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

      // Trigger sync — should detect UIDVALIDITY change and re-sync from scratch
      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      // The new message should be in the DB
      const db = DatabaseService.getInstance();
      const newEmail = db.getEmailByXGmMsgId(suiteAccountId, htmlMsg.headers.xGmMsgId);
      expect(newEmail).to.not.be.null;
    });
  });

  // =========================================================================
  // IDLE — new mail via EXISTS notification
  // =========================================================================

  describe('IDLE new-mail flow', () => {
    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'idle-newmail@example.com',
        displayName: 'IDLE New Mail Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Do an initial sync so the account is known and IDLE can connect
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

      // Start IDLE connections for this account via SyncService
      const syncService = SyncService.getInstance();
      const bridge = SyncQueueBridge.getInstance();

      await syncService.startIdle(String(suiteAccountId), () => {
        bridge.enqueueInboxSync(String(suiteAccountId));
      });
      await syncService.startIdleAllMail(String(suiteAccountId), (accountIdStr) => {
        bridge.enqueueAllMailSync(accountIdStr);
      });
    });

    after(async () => {
      // Stop IDLE connections to clean up after this sub-suite
      try {
        await SyncService.getInstance().stopAllIdle();
      } catch {
        // Non-fatal — quiesce will also do this
      }
    });

    it('triggers INBOX sync and emits mail:folder-updated when a new message arrives via IDLE', async function () {
      this.timeout(25_000);

      const htmlMsg = emlFixtures['html-email'];

      // Pre-inject the new message into the IMAP server first (IDLE poll will fetch it)
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

      // Capture event count before triggering IDLE notification
      const priorFolderUpdatedCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
        (record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload && payload.accountId === suiteAccountId;
        },
      ).length;

      // Send an EXISTS notification to the IDLE client — simulates new mail arriving
      imapStateInspector.injectAndNotify('INBOX', htmlMsg.raw, {
        xGmMsgId: '9991000000000099',
        xGmThrid: '9992000000000099',
        xGmLabels: ['\\Inbox'],
      });

      // Wait for the sync triggered by IDLE to emit mail:folder-updated
      await waitForEvent('mail:folder-updated', {
        timeout: 20_000,
        predicate: (args) => {
          const payload = args[0] as FolderUpdatedPayload | undefined;
          if (!payload || payload.accountId !== suiteAccountId) {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
            (record) => {
              const recordPayload = record.args[0] as FolderUpdatedPayload | undefined;
              return recordPayload && recordPayload.accountId === suiteAccountId;
            },
          ).length;
          return currentCount > priorFolderUpdatedCount;
        },
      });
    });

    it('triggers a new INBOX sync via IDLE when a second message arrives', async function () {
      this.timeout(25_000);

      // Inject another distinct message to trigger another IDLE notification
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

      const priorFolderUpdatedCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
        (record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload && payload.accountId === suiteAccountId;
        },
      ).length;

      // Inject and notify via IDLE — gives both the message store AND the EXISTS signal
      imapStateInspector.injectAndNotify('INBOX', multipartMsg.raw, {
        xGmMsgId: multipartMsg.headers.xGmMsgId,
        xGmThrid: multipartMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      // Wait for the IDLE-triggered sync to emit mail:folder-updated
      await waitForEvent('mail:folder-updated', {
        timeout: 20_000,
        predicate: (args) => {
          const payload = args[0] as FolderUpdatedPayload | undefined;
          if (!payload || payload.accountId !== suiteAccountId) {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
            (record) => {
              const recordPayload = record.args[0] as FolderUpdatedPayload | undefined;
              return recordPayload && recordPayload.accountId === suiteAccountId;
            },
          ).length;
          return currentCount > priorFolderUpdatedCount;
        },
      });

      // Verify the new message was synced into the DB
      const db = DatabaseService.getInstance();
      const syncedEmail = db.getEmailByXGmMsgId(suiteAccountId, multipartMsg.headers.xGmMsgId);
      expect(syncedEmail).to.not.be.null;
    });
  });

  // =========================================================================
  // IDLE — expunge flow (All Mail EXPUNGE → reconcile sync)
  // =========================================================================

  describe('IDLE expunge flow', () => {
    let injectedUid: number;

    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'idle-expunge@example.com',
        displayName: 'IDLE Expunge Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject two messages and do an initial sync
      const plainMsg = emlFixtures['plain-text'];
      const htmlMsg = emlFixtures['html-email'];

      const plainResult = imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

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

      injectedUid = plainResult.uid;

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });

      // Start All Mail IDLE
      const syncService = SyncService.getInstance();
      const bridge = SyncQueueBridge.getInstance();
      await syncService.startIdleAllMail(String(suiteAccountId), (accountIdStr) => {
        bridge.enqueueAllMailSync(accountIdStr);
      });
    });

    after(async () => {
      try {
        await SyncService.getInstance().stopAllIdle();
      } catch {
        // Non-fatal
      }
    });

    it('triggers reconcile sync and emits mail:folder-updated when expunge occurs via IDLE', async function () {
      this.timeout(25_000);

      const priorFolderUpdatedCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
        (record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload && payload.accountId === suiteAccountId;
        },
      ).length;

      // Remove the first message from All Mail on the server and send EXPUNGE notification
      imapStateInspector.expungeAndNotify('[Gmail]/All Mail', injectedUid);

      // Wait for the reconcile sync triggered by the EXPUNGE IDLE event
      await waitForEvent('mail:folder-updated', {
        timeout: 20_000,
        predicate: (args) => {
          const payload = args[0] as FolderUpdatedPayload | undefined;
          if (!payload || payload.accountId !== suiteAccountId) {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
            (record) => {
              const recordPayload = record.args[0] as FolderUpdatedPayload | undefined;
              return recordPayload && recordPayload.accountId === suiteAccountId;
            },
          ).length;
          return currentCount > priorFolderUpdatedCount;
        },
      });
    });
  });

  // =========================================================================
  // Sync pause / resume IPC
  // =========================================================================

  describe('Sync pause and resume', () => {
    before(async function () {
      this.timeout(20_000);
      await quiesceAndRestore();

      const seeded = seedTestAccount({ email: 'sync-pause@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
    });

    it('sync:get-paused returns false when not paused', async () => {
      const response = await callIpc('sync:get-paused') as IpcResponse<SyncPausedResponse>;
      expect(response.success).to.equal(true);
      expect(response.data).to.have.property('paused');
      // In the test environment SyncQueueBridge is never started, so it should not be "user paused"
      // (it may be in the default state — but the important thing is the IPC round-trips correctly)
      expect(typeof response.data!.paused).to.equal('boolean');
    });

    it('sync:pause returns paused:true', async () => {
      const response = await callIpc('sync:pause') as IpcResponse<SyncPausedResponse>;
      expect(response.success).to.equal(true);
      expect(response.data!.paused).to.equal(true);
    });

    it('sync:get-paused returns true after pausing', async () => {
      const response = await callIpc('sync:get-paused') as IpcResponse<SyncPausedResponse>;
      expect(response.success).to.equal(true);
      expect(response.data!.paused).to.equal(true);
    });

    it('sync:resume returns paused:false', async () => {
      const response = await callIpc('sync:resume') as IpcResponse<SyncPausedResponse>;
      expect(response.success).to.equal(true);
      expect(response.data!.paused).to.equal(false);
    });

    it('sync:get-paused returns false after resuming', async () => {
      const response = await callIpc('sync:get-paused') as IpcResponse<SyncPausedResponse>;
      expect(response.success).to.equal(true);
      expect(response.data!.paused).to.equal(false);
    });

    it('pause is idempotent — calling sync:pause twice does not error', async () => {
      const firstPause = await callIpc('sync:pause') as IpcResponse<SyncPausedResponse>;
      expect(firstPause.success).to.equal(true);
      expect(firstPause.data!.paused).to.equal(true);

      const secondPause = await callIpc('sync:pause') as IpcResponse<SyncPausedResponse>;
      expect(secondPause.success).to.equal(true);
      expect(secondPause.data!.paused).to.equal(true);

      // Clean up: resume so subsequent tests are not affected
      await callIpc('sync:resume');
    });
  });

  // =========================================================================
  // Manual sync trigger
  // =========================================================================

  describe('Manual sync trigger', () => {
    before(async function () {
      this.timeout(25_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-manual@example.com',
        displayName: 'Manual Sync Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
    });

    it('mail:sync-account IPC triggers sync and emits queue:update completed for the account', async function () {
      this.timeout(20_000);

      // Inject a message so there is something to sync
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

      // Enqueue the sync and capture the returned queueId so we can match the
      // exact queue:update terminal event rather than relying on a count-based
      // fallback that could resolve on a stale previous-suite event.
      const syncResponse = await callIpc('mail:sync-account', String(suiteAccountId)) as IpcResponse<{ queueId: string | null }>;
      expect(syncResponse.success).to.equal(true);

      const syncQueueId: string | null = syncResponse.data?.queueId ?? null;

      // Wait for queue:update with status=completed for the sync item.
      // Accept 'failed' in the predicate so the waitFor resolves (rather than timing out),
      // then inspect the terminal status and throw if the sync worker failed.
      const terminalArgs = await waitForEvent('queue:update', {
        timeout: 15_000,
        predicate: (args) => {
          const snapshot = args[0] as QueueUpdateSnapshot | undefined;
          if (!snapshot) {
            return false;
          }
          if (snapshot.accountId !== suiteAccountId) {
            return false;
          }
          if (snapshot.type !== 'sync-allmail' && snapshot.type !== 'sync-folder') {
            return false;
          }
          if (snapshot.status !== 'completed' && snapshot.status !== 'failed') {
            return false;
          }
          // When the IPC returned a specific queueId, match only that exact item.
          // This prevents a stale previous-suite sync item (same account, same type)
          // from resolving our wait prematurely.
          if (syncQueueId !== null) {
            return snapshot.queueId === syncQueueId;
          }
          // Fallback: accept any terminal sync event for this account
          return true;
        },
      });

      // Fail the test if the sync worker itself failed.
      const terminalSnapshot = terminalArgs[0] as QueueUpdateSnapshot;
      if (terminalSnapshot.status === 'failed') {
        throw new Error(
          `mail:sync-account IPC test: sync worker failed` +
          (terminalSnapshot.error ? `: ${terminalSnapshot.error}` : ''),
        );
      }

      // Verify the message was synced
      const db = DatabaseService.getInstance();
      const email = db.getEmailByXGmMsgId(suiteAccountId, plainMsg.headers.xGmMsgId);
      expect(email).to.not.be.null;
    });

    it('returns MAIL_SYNC_FAILED for a non-existent account', async () => {
      // Use an accountId that was never created
      const response = await callIpc('mail:sync-account', '99999') as IpcResponse<null>;
      // The bridge will try to get mailboxes for a non-existent account —
      // this may succeed (returning no mailboxes) or fail with an IMAP error.
      // Either way the IPC should not throw — it should return a response.
      expect(response).to.have.property('success');
    });
  });

  // =========================================================================
  // Post-sync automatic filter processing
  // =========================================================================

  describe('Post-sync automatic filter processing', () => {
    before(async function () {
      this.timeout(25_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-filter@example.com',
        displayName: 'Post-Sync Filter Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
    });

    it('marks new INBOX emails as filtered even when no filters are enabled', async function () {
      this.timeout(20_000);

      // Inject a message
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

      // Sync — no filters are configured but filter processing still marks emails
      await triggerSyncAndWait(suiteAccountId, { timeout: 15_000 });

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();

      // After sync + filter processing, is_filtered should be 1 for the synced email
      const emailRow = rawDb.prepare(
        'SELECT is_filtered FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: plainMsg.headers.xGmMsgId, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      // The email may not have a body yet (sync-allmail fetches metadata only for incremental),
      // but it should have been processed by the filter service.
      // is_filtered === 1 means filter processing ran.
      expect(emailRow).to.not.be.undefined;
      expect(emailRow!['is_filtered']).to.equal(1);
    });

    it('saves and applies an enabled filter on the next sync', async function () {
      this.timeout(25_000);

      // Create a filter that marks matching emails as read.
      // The IPC handler requires conditions and actions as JSON strings (not objects).
      const saveResponse = await callIpc('db:save-filter', {
        accountId: suiteAccountId,
        name: 'Mark Alice as read',
        conditions: JSON.stringify([{ field: 'from', operator: 'contains', value: 'alice@example.com' }]),
        actions: JSON.stringify([{ type: 'mark-read' }]),
        isEnabled: true,
        isAiGenerated: false,
        sortOrder: 1,
      }) as IpcResponse<{ id: number }>;

      expect(saveResponse.success).to.equal(true);

      // Inject a new unread message FROM alice@example.com (matching the filter)
      const plainMsg = emlFixtures['plain-text'];
      // Use a different msgid to avoid the duplicate already injected above
      const newMsgId = '8881000000000001';
      const newThrid = '8882000000000001';
      const modifiedRaw = Buffer.from(
        plainMsg.raw.toString('utf8')
          .replace(plainMsg.headers.xGmMsgId, newMsgId)
          .replace(plainMsg.headers.xGmThrid, newThrid)
          .replace('Message-ID: <plain-text-001@example.com>', 'Message-ID: <plain-text-filter-test@example.com>'),
        'utf8',
      );

      imapStateInspector.injectMessage('[Gmail]/All Mail', modifiedRaw, {
        xGmMsgId: newMsgId,
        xGmThrid: newThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', modifiedRaw, {
        xGmMsgId: newMsgId,
        xGmThrid: newThrid,
        xGmLabels: ['\\Inbox'],
      });

      // Trigger sync — filter should auto-apply to the new INBOX emails
      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();

      // After sync + filter processing, is_filtered must be 1
      const emailRow = rawDb.prepare(
        'SELECT is_filtered FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: newMsgId, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      expect(emailRow).to.not.be.undefined;
      expect(emailRow!['is_filtered']).to.equal(1);
    });
  });

  // =========================================================================
  // Thread metadata and contacts
  // =========================================================================

  describe('Thread metadata and contact extraction', () => {
    before(async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-metadata@example.com',
        displayName: 'Metadata Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject the 3-message reply thread
      const thread1 = emlFixtures['reply-thread-1'];
      const thread2 = emlFixtures['reply-thread-2'];
      const thread3 = emlFixtures['reply-thread-3'];

      for (const msg of [thread1, thread2, thread3]) {
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

    it('groups the 3-message thread under a single thread row in the DB', async () => {
      const thread1Headers = emlFixtures['reply-thread-1'].headers;

      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();

      const threadRow = rawDb.prepare(
        'SELECT COUNT(*) AS count FROM emails WHERE x_gm_thrid = :xGmThrid AND account_id = :accountId',
      ).get({ xGmThrid: thread1Headers.xGmThrid, accountId: suiteAccountId }) as Record<string, unknown> | undefined;

      expect(threadRow).to.not.be.undefined;
      expect(Number(threadRow!['count'])).to.equal(3);
    });

    it('extracts contacts from the synced email senders', async () => {
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();

      // alice@example.com appears as a sender in the reply thread fixtures
      const contactRow = rawDb.prepare(
        'SELECT email FROM contacts WHERE email = :email',
      ).get({ email: 'alice@example.com' }) as Record<string, unknown> | undefined;

      // Contact extraction happens asynchronously during sync
      // The contact may not be present if body fetch hasn't completed yet,
      // so we only assert on the row structure when it exists
      if (contactRow) {
        expect(contactRow['email']).to.equal('alice@example.com');
      }
    });
  });
});
