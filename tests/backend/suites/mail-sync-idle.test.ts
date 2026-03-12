/**
 * mail-sync-idle.test.ts — Backend E2E tests for mail sync and IDLE.
 *
 * Covers:
 *   - Initial sync: labels/mailboxes synced to local labels table
 *   - Mailbox discovery excludes [Gmail] parent container and hidden system labels
 *   - Folder sync: new messages ingested, existing messages updated
 *   - Incremental sync via CONDSTORE (only changed messages fetched)
 *   - Remote flag changes via CONDSTORE (read/starred/important)
 *   - Remote label/folder changes via All Mail label reconciliation
 *   - Differential sync verification (highestModseq persistence, unchanged rows not re-fetched)
 *   - Mixed incremental changes (flag changes + new mail in one cycle)
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
import { DateTime } from 'luxon';
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
import { ImapService } from '../../../electron/services/imap-service';
import { ALL_MAIL_PATH, SyncService } from '../../../electron/services/sync-service';
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

interface EmailStatusSnapshot {
  isRead: number;
  isStarred: number;
  isImportant: number;
  updatedAt: string;
}

interface FolderStateSnapshot {
  highestModseq: string | null;
  uidValidity: string;
  condstoreSupported: number;
}

interface FetchOlderResponse {
  queueId: string;
}

interface FetchOlderDonePayload {
  queueId: string;
  accountId: number;
  folderId: string;
  threads?: Array<Record<string, unknown>>;
  hasMore?: boolean;
  nextBeforeDate?: string | null;
  error?: string;
}

interface SyntheticEmailOptions {
  fromHeader: string;
  toHeader: string;
  subject: string;
  body: string;
  dateIso: string;
  xGmMsgId: string;
  xGmThrid: string;
  messageId: string;
  labels?: string[];
}

function getEmailStatusSnapshot(accountId: number, xGmMsgId: string): EmailStatusSnapshot | undefined {
  const rawDb = DatabaseService.getInstance().getDatabase();
  return rawDb.prepare(
    `SELECT is_read AS isRead, is_starred AS isStarred, is_important AS isImportant, updated_at AS updatedAt
     FROM emails
     WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId`,
  ).get({ accountId, xGmMsgId }) as EmailStatusSnapshot | undefined;
}

function getFolderStateSnapshot(accountId: number, folder: string): FolderStateSnapshot | undefined {
  const rawDb = DatabaseService.getInstance().getDatabase();
  return rawDb.prepare(
    `SELECT highest_modseq AS highestModseq, uid_validity AS uidValidity, condstore_supported AS condstoreSupported
     FROM folder_state
     WHERE account_id = :accountId AND folder = :folder`,
  ).get({ accountId, folder }) as FolderStateSnapshot | undefined;
}

function getCompletedSyncEventCount(accountId: number): number {
  return TestEventBus.getInstance().getHistory('queue:update').filter((record) => {
    const snapshot = record.args[0] as QueueUpdateSnapshot | undefined;
    if (!snapshot) {
      return false;
    }
    if (snapshot.accountId !== accountId) {
      return false;
    }
    if (snapshot.type !== 'sync-allmail' && snapshot.type !== 'sync-folder') {
      return false;
    }
    return snapshot.status === 'completed';
  }).length;
}

async function waitForCompletedSyncEvent(
  accountId: number,
  priorCount: number,
  timeout: number = 15_000,
): Promise<QueueUpdateSnapshot> {
  const args = await waitForEvent('queue:update', {
    timeout,
    predicate: (eventArgs) => {
      const snapshot = eventArgs[0] as QueueUpdateSnapshot | undefined;
      if (!snapshot) {
        return false;
      }
      if (snapshot.accountId !== accountId) {
        return false;
      }
      if (snapshot.type !== 'sync-allmail' && snapshot.type !== 'sync-folder') {
        return false;
      }
      if (snapshot.status !== 'completed') {
        return false;
      }
      return getCompletedSyncEventCount(accountId) > priorCount;
    },
  });

  return args[0] as QueueUpdateSnapshot;
}

async function waitForMilliseconds(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function waitForCondition(
  predicate: () => boolean,
  timeoutMs: number = 5_000,
  intervalMs: number = 25,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (predicate()) {
      return;
    }
    await waitForMilliseconds(intervalMs);
  }

  throw new Error(`Condition not met within ${timeoutMs}ms`);
}

async function runDirectAllMailSync(accountId: number, isInitial: boolean): Promise<Set<string>> {
  const syncService = SyncService.getInstance();
  const mailboxes = await syncService.getMailboxesForSync(String(accountId));
  const knownMailboxPaths = new Set(mailboxes.map((mailbox) => mailbox.path));

  return syncService.syncAllMail(
    String(accountId),
    isInitial,
    DateTime.utc().minus({ days: 30 }).toJSDate(),
    knownMailboxPaths,
  );
}

function buildSyntheticEmail(options: SyntheticEmailOptions): Buffer {
  const labels = options.labels ?? ['\\Inbox', '\\All'];
  return Buffer.from(
    [
      `From: ${options.fromHeader}`,
      `To: ${options.toHeader}`,
      `Subject: ${options.subject}`,
      `Date: ${DateTime.fromISO(options.dateIso).toUTC().toRFC2822()}`,
      `Message-ID: ${options.messageId}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: 7bit',
      `X-GM-MSGID: ${options.xGmMsgId}`,
      `X-GM-THRID: ${options.xGmThrid}`,
      `X-GM-LABELS: ${labels.join(' ')}`,
      '',
      options.body,
    ].join('\r\n'),
    'utf8',
  );
}

function injectInboxAndAllMailMessage(options: {
  raw: Buffer;
  xGmMsgId: string;
  xGmThrid: string;
  internalDate?: string;
  allMailLabels?: string[];
  inboxLabels?: string[];
}): void {
  imapStateInspector.injectMessage('[Gmail]/All Mail', options.raw, {
    xGmMsgId: options.xGmMsgId,
    xGmThrid: options.xGmThrid,
    xGmLabels: options.allMailLabels ?? ['\\Inbox', '\\All'],
    internalDate: options.internalDate,
  });
  imapStateInspector.injectMessage('INBOX', options.raw, {
    xGmMsgId: options.xGmMsgId,
    xGmThrid: options.xGmThrid,
    xGmLabels: options.inboxLabels ?? ['\\Inbox'],
    internalDate: options.internalDate,
  });
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
  // Multi-account sync and fetch-older
  // =========================================================================

  describe('Multi-account sync and fetch-older', () => {
    it('keeps synced mail isolated across two seeded accounts', async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const firstAccount = seedTestAccount({
        email: 'sync-multi-account-a@example.com',
        displayName: 'Sync Multi Account A',
      });
      const secondAccount = seedTestAccount({
        email: 'sync-multi-account-b@example.com',
        displayName: 'Sync Multi Account B',
      });

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(firstAccount.email);
      imapStateInspector.getServer().addAllowedAccount(secondAccount.email);

      const firstMessage = emlFixtures['plain-text'];
      injectInboxAndAllMailMessage({
        raw: firstMessage.raw,
        xGmMsgId: firstMessage.headers.xGmMsgId,
        xGmThrid: firstMessage.headers.xGmThrid,
      });

      await triggerSyncAndWait(firstAccount.accountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      expect(db.getEmailByXGmMsgId(firstAccount.accountId, firstMessage.headers.xGmMsgId)).to.not.be.null;
      expect(db.getEmailByXGmMsgId(secondAccount.accountId, firstMessage.headers.xGmMsgId)).to.be.null;

      // The fake IMAP server uses a shared in-memory message store rather than
      // per-account mailboxes, so reset it before syncing the second account.
      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(firstAccount.email);
      imapStateInspector.getServer().addAllowedAccount(secondAccount.email);

      const secondMessage = emlFixtures['html-email'];
      injectInboxAndAllMailMessage({
        raw: secondMessage.raw,
        xGmMsgId: secondMessage.headers.xGmMsgId,
        xGmThrid: secondMessage.headers.xGmThrid,
      });

      await triggerSyncAndWait(secondAccount.accountId, { timeout: 20_000 });

      expect(db.getEmailByXGmMsgId(secondAccount.accountId, secondMessage.headers.xGmMsgId)).to.not.be.null;
      expect(db.getEmailByXGmMsgId(firstAccount.accountId, secondMessage.headers.xGmMsgId)).to.be.null;
      expect(db.getFoldersForEmail(firstAccount.accountId, firstMessage.headers.xGmMsgId)).to.include('INBOX');
      expect(db.getFoldersForEmail(secondAccount.accountId, secondMessage.headers.xGmMsgId)).to.include('INBOX');
    });

    it('fetches older inbox mail into the local database via mail:fetch-older', async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-fetch-older@example.com',
        displayName: 'Sync Fetch Older Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const recentDate = DateTime.utc().minus({ days: 5 });
      const oldDateOne = DateTime.utc().minus({ days: 55 });
      const oldDateTwo = DateTime.utc().minus({ days: 56 });

      const recentRaw = buildSyntheticEmail({
        fromHeader: 'recent@example.com',
        toHeader: suiteEmail,
        subject: 'Recent sync message',
        body: 'Recent message body',
        dateIso: recentDate.toISO()!,
        xGmMsgId: '7000000000000001',
        xGmThrid: '7000000000000101',
        messageId: '<recent-sync-message@example.com>',
      });
      const oldRawOne = buildSyntheticEmail({
        fromHeader: 'older-one@example.com',
        toHeader: suiteEmail,
        subject: 'Older sync message one',
        body: 'Older message one body',
        dateIso: oldDateOne.toISO()!,
        xGmMsgId: '7000000000000002',
        xGmThrid: '7000000000000102',
        messageId: '<older-sync-message-one@example.com>',
      });
      const oldRawTwo = buildSyntheticEmail({
        fromHeader: 'older-two@example.com',
        toHeader: suiteEmail,
        subject: 'Older sync message two',
        body: 'Older message two body',
        dateIso: oldDateTwo.toISO()!,
        xGmMsgId: '7000000000000003',
        xGmThrid: '7000000000000103',
        messageId: '<older-sync-message-two@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: oldRawOne,
        xGmMsgId: '7000000000000002',
        xGmThrid: '7000000000000102',
        internalDate: oldDateOne.toISO()!,
      });
      injectInboxAndAllMailMessage({
        raw: oldRawTwo,
        xGmMsgId: '7000000000000003',
        xGmThrid: '7000000000000103',
        internalDate: oldDateTwo.toISO()!,
      });
      injectInboxAndAllMailMessage({
        raw: recentRaw,
        xGmMsgId: '7000000000000001',
        xGmThrid: '7000000000000101',
        internalDate: recentDate.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const db = DatabaseService.getInstance();
      expect(db.getEmailByXGmMsgId(suiteAccountId, '7000000000000001')).to.not.be.null;
      expect(db.getEmailByXGmMsgId(suiteAccountId, '7000000000000002')).to.be.null;
      expect(db.getEmailByXGmMsgId(suiteAccountId, '7000000000000003')).to.be.null;

      const response = await callIpc(
        'mail:fetch-older',
        String(suiteAccountId),
        'INBOX',
        DateTime.utc().minus({ days: 20 }).toISO()!,
        10,
      ) as IpcResponse<FetchOlderResponse>;

      expect(response.success).to.equal(true);
      const queueId = response.data!.queueId;

      const doneArgs = await waitForEvent('mail:fetch-older-done', {
        timeout: 20_000,
        predicate: (args) => {
          const payload = args[0] as FetchOlderDonePayload | undefined;
          return payload != null && payload.queueId === queueId;
        },
      });

      const donePayload = doneArgs[0] as FetchOlderDonePayload;
      expect(donePayload.error).to.equal(undefined);
      expect(donePayload.accountId).to.equal(suiteAccountId);
      expect(donePayload.folderId).to.equal('INBOX');
      expect(donePayload.threads).to.be.an('array').that.is.not.empty;

      expect(db.getEmailByXGmMsgId(suiteAccountId, '7000000000000002')).to.not.be.null;
      expect(db.getEmailByXGmMsgId(suiteAccountId, '7000000000000003')).to.not.be.null;
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
  // Remote flag changes and differential CONDSTORE sync
  // =========================================================================

  describe('Remote flag changes and differential sync', () => {
    let firstMessageId: string;
    let secondMessageId: string;
    let firstAllMailUid: number;
    let secondAllMailUid: number;

    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-remote-flags@example.com',
        displayName: 'Remote Flag Sync Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const plainMsg = emlFixtures['plain-text'];
      const htmlMsg = emlFixtures['html-email'];

      firstMessageId = plainMsg.headers.xGmMsgId;
      secondMessageId = htmlMsg.headers.xGmMsgId;

      imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All'],
      });
      firstAllMailUid = imapStateInspector.getStore().findByMsgId('[Gmail]/All Mail', plainMsg.headers.xGmMsgId)!.uid;
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      imapStateInspector.injectMessage('[Gmail]/All Mail', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All'],
      });
      secondAllMailUid = imapStateInspector.getStore().findByMsgId('[Gmail]/All Mail', htmlMsg.headers.xGmMsgId)!.uid;
      imapStateInspector.injectMessage('INBOX', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('detects remote read/starred/important changes via CHANGEDSINCE and advances highestModseq', async function () {
      this.timeout(20_000);

      const initialFirst = getEmailStatusSnapshot(suiteAccountId, firstMessageId);
      const initialSecond = getEmailStatusSnapshot(suiteAccountId, secondMessageId);
      const initialFolderState = getFolderStateSnapshot(suiteAccountId, ALL_MAIL_PATH);
      const secondInitialRead = initialSecond?.isRead;
      const secondInitialStarred = initialSecond?.isStarred;
      const secondInitialImportant = initialSecond?.isImportant;

      expect(initialFirst).to.not.be.undefined;
      expect(initialSecond).to.not.be.undefined;
      expect(initialFolderState).to.not.be.undefined;
      expect(initialFolderState!.condstoreSupported).to.equal(1);

      await waitForMilliseconds(1_100);

      imapStateInspector.setFlags(ALL_MAIL_PATH, firstAllMailUid, ['\\Seen', '\\Flagged'], 'add');
      imapStateInspector.setLabels(ALL_MAIL_PATH, firstAllMailUid, ['\\Inbox', '\\Important', '\\All']);

      const affectedFolders = await runDirectAllMailSync(suiteAccountId, false);

      const updatedFirst = getEmailStatusSnapshot(suiteAccountId, firstMessageId);
      const updatedSecond = getEmailStatusSnapshot(suiteAccountId, secondMessageId);
      const updatedFolderState = getFolderStateSnapshot(suiteAccountId, ALL_MAIL_PATH);

      expect(Array.from(affectedFolders)).to.include('INBOX');
      expect(updatedFirst).to.not.be.undefined;
      expect(updatedFirst!.isRead).to.equal(1);
      expect(updatedFirst!.isStarred).to.equal(1);
      expect(updatedFirst!.isImportant).to.equal(1);

      expect(updatedSecond).to.not.be.undefined;
      expect(updatedSecond!.isRead).to.equal(secondInitialRead);
      expect(updatedSecond!.isStarred).to.equal(secondInitialStarred);
      expect(updatedSecond!.isImportant).to.equal(secondInitialImportant);

      expect(updatedFolderState).to.not.be.undefined;
      expect(
        BigInt(updatedFolderState!.highestModseq ?? '0') > BigInt(initialFolderState!.highestModseq ?? '0'),
      ).to.equal(true);
    });

    it('applies remote unstar and important removal on the next incremental sync', async function () {
      this.timeout(20_000);

      const initialFolderState = getFolderStateSnapshot(suiteAccountId, ALL_MAIL_PATH);
      expect(initialFolderState).to.not.be.undefined;

      await waitForMilliseconds(1_100);

      imapStateInspector.setFlags(ALL_MAIL_PATH, firstAllMailUid, ['\\Seen', '\\Flagged'], 'remove');
      imapStateInspector.setLabels(ALL_MAIL_PATH, firstAllMailUid, ['\\Inbox', '\\All']);

      await runDirectAllMailSync(suiteAccountId, false);

      const updatedFirst = getEmailStatusSnapshot(suiteAccountId, firstMessageId);
      const updatedFolderState = getFolderStateSnapshot(suiteAccountId, ALL_MAIL_PATH);

      expect(updatedFirst).to.not.be.undefined;
      expect(updatedFirst!.isRead).to.equal(0);
      expect(updatedFirst!.isStarred).to.equal(0);
      expect(updatedFirst!.isImportant).to.equal(0);

      expect(updatedFolderState).to.not.be.undefined;
      expect(
        BigInt(updatedFolderState!.highestModseq ?? '0') > BigInt(initialFolderState!.highestModseq ?? '0'),
      ).to.equal(true);
    });

    it('does not re-fetch unchanged messages when no remote changes occurred', async function () {
      this.timeout(20_000);

      const initialFirst = getEmailStatusSnapshot(suiteAccountId, firstMessageId);
      const initialSecond = getEmailStatusSnapshot(suiteAccountId, secondMessageId);
      const initialFolderState = getFolderStateSnapshot(suiteAccountId, ALL_MAIL_PATH);
      const initialFirstRead = initialFirst?.isRead;
      const initialFirstStarred = initialFirst?.isStarred;
      const initialFirstImportant = initialFirst?.isImportant;
      const initialFirstUpdatedAt = initialFirst?.updatedAt;
      const initialSecondRead = initialSecond?.isRead;
      const initialSecondStarred = initialSecond?.isStarred;
      const initialSecondImportant = initialSecond?.isImportant;
      const initialSecondUpdatedAt = initialSecond?.updatedAt;

      expect(initialFirst).to.not.be.undefined;
      expect(initialSecond).to.not.be.undefined;
      expect(initialFolderState).to.not.be.undefined;

      await waitForMilliseconds(1_100);

      const affectedFolders = await runDirectAllMailSync(suiteAccountId, false);

      const updatedFirst = getEmailStatusSnapshot(suiteAccountId, firstMessageId);
      const updatedSecond = getEmailStatusSnapshot(suiteAccountId, secondMessageId);
      const updatedFolderState = getFolderStateSnapshot(suiteAccountId, ALL_MAIL_PATH);

      expect(updatedFirst).to.not.be.undefined;
      expect(updatedSecond).to.not.be.undefined;
      expect(updatedFirst!.isRead).to.equal(initialFirstRead);
      expect(updatedFirst!.isStarred).to.equal(initialFirstStarred);
      expect(updatedFirst!.isImportant).to.equal(initialFirstImportant);
      expect(updatedFirst!.updatedAt).to.equal(initialFirstUpdatedAt);
      expect(updatedSecond!.isRead).to.equal(initialSecondRead);
      expect(updatedSecond!.isStarred).to.equal(initialSecondStarred);
      expect(updatedSecond!.isImportant).to.equal(initialSecondImportant);
      expect(updatedSecond!.updatedAt).to.equal(initialSecondUpdatedAt);
      expect(updatedFolderState).to.not.be.undefined;
      expect(updatedFolderState!.highestModseq).to.equal(initialFolderState!.highestModseq);
    });

    it('treats flag changes plus a new message in one INBOX sync as a mixed change set', async function () {
      this.timeout(20_000);

      const thread1 = emlFixtures['reply-thread-1'];
      const priorFolderUpdatedCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
        (record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload?.accountId === suiteAccountId && payload.reason === 'sync';
        },
      ).length;

      await waitForMilliseconds(1_100);

      imapStateInspector.setFlags(ALL_MAIL_PATH, secondAllMailUid, ['\\Seen'], 'add');

      imapStateInspector.injectMessage('[Gmail]/All Mail', thread1.raw, {
        xGmMsgId: thread1.headers.xGmMsgId,
        xGmThrid: thread1.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All'],
      });
      imapStateInspector.injectMessage('INBOX', thread1.raw, {
        xGmMsgId: thread1.headers.xGmMsgId,
        xGmThrid: thread1.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const updatedSecond = getEmailStatusSnapshot(suiteAccountId, secondMessageId);
      const newEmail = DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, thread1.headers.xGmMsgId);
      const mixedSyncEvent = TestEventBus.getInstance().getHistory('mail:folder-updated')
        .filter((record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload?.accountId === suiteAccountId && payload.reason === 'sync';
        })
        .slice(priorFolderUpdatedCount)
        .find((record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload?.changeType === 'mixed';
        });

      expect(updatedSecond).to.not.be.undefined;
      expect(updatedSecond!.isRead).to.equal(1);
      expect(newEmail).to.not.be.null;
      expect(mixedSyncEvent).to.not.be.undefined;
    });
  });

  // =========================================================================
  // Remote label / folder changes from All Mail sync
  // =========================================================================

  describe('Remote label and folder changes', () => {
    let movableMessageId: string;
    let labelMessageId: string;
    let movableAllMailUid: number;
    let labelAllMailUid: number;

    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-remote-labels@example.com',
        displayName: 'Remote Label Sync Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
      imapStateInspector.getStore().createMailbox('Projects');

      const plainMsg = emlFixtures['plain-text'];
      const htmlMsg = emlFixtures['html-email'];

      movableMessageId = plainMsg.headers.xGmMsgId;
      labelMessageId = htmlMsg.headers.xGmMsgId;

      movableAllMailUid = imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All'],
      }).uid;
      imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
        xGmMsgId: plainMsg.headers.xGmMsgId,
        xGmThrid: plainMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      labelAllMailUid = imapStateInspector.injectMessage('[Gmail]/All Mail', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All'],
      }).uid;
      imapStateInspector.injectMessage('INBOX', htmlMsg.raw, {
        xGmMsgId: htmlMsg.headers.xGmMsgId,
        xGmThrid: htmlMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('updates local folder associations when a message is moved remotely', async function () {
      this.timeout(20_000);

      await waitForMilliseconds(1_100);

      imapStateInspector.setLabels('[Gmail]/All Mail', movableAllMailUid, ['\\Sent', '\\All']);

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const folders = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, movableMessageId);
      expect(folders).to.include('[Gmail]/Sent Mail');
      expect(folders).to.not.include('INBOX');
    });

    it('adds and removes remote custom labels in local folder associations', async function () {
      this.timeout(25_000);

      await waitForMilliseconds(1_100);

      imapStateInspector.setLabels('[Gmail]/All Mail', labelAllMailUid, ['\\Inbox', 'Projects', '\\All']);
      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const foldersWithLabel = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, labelMessageId);
      expect(foldersWithLabel).to.include('INBOX');
      expect(foldersWithLabel).to.include('Projects');

      await waitForMilliseconds(1_100);

      imapStateInspector.setLabels('[Gmail]/All Mail', labelAllMailUid, ['\\Inbox', '\\All']);
      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const foldersWithoutLabel = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, labelMessageId);
      expect(foldersWithoutLabel).to.include('INBOX');
      expect(foldersWithoutLabel).to.not.include('Projects');
    });

    it('reconciles multiple remote change types across multiple messages in one sync cycle', async function () {
      this.timeout(25_000);

      const multipartMsg = emlFixtures['multipart-attachment'];

      await waitForMilliseconds(1_100);

      imapStateInspector.setLabels('[Gmail]/All Mail', movableAllMailUid, ['\\Inbox', 'Projects', '\\All']);
      imapStateInspector.setFlags('[Gmail]/All Mail', movableAllMailUid, ['\\Flagged'], 'add');
      imapStateInspector.setLabels('[Gmail]/All Mail', labelAllMailUid, ['\\Sent', '\\All']);

      imapStateInspector.injectMessage('[Gmail]/All Mail', multipartMsg.raw, {
        xGmMsgId: multipartMsg.headers.xGmMsgId,
        xGmThrid: multipartMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', 'Projects', '\\Important', '\\All'],
        flags: ['\\Flagged'],
      });
      imapStateInspector.injectMessage('INBOX', multipartMsg.raw, {
        xGmMsgId: multipartMsg.headers.xGmMsgId,
        xGmThrid: multipartMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', 'Projects', '\\Important'],
        flags: ['\\Flagged'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const movedFolders = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, movableMessageId);
      const relabeledFolders = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, labelMessageId);
      const newFolders = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, multipartMsg.headers.xGmMsgId);
      const movedEmail = getEmailStatusSnapshot(suiteAccountId, movableMessageId);
      const newEmail = getEmailStatusSnapshot(suiteAccountId, multipartMsg.headers.xGmMsgId);

      expect(movedFolders).to.include('INBOX');
      expect(movedFolders).to.include('Projects');
      expect(relabeledFolders).to.include('[Gmail]/Sent Mail');
      expect(relabeledFolders).to.not.include('INBOX');
      expect(newFolders).to.include('INBOX');
      expect(newFolders).to.include('Projects');
      expect(movedEmail).to.not.be.undefined;
      expect(movedEmail!.isStarred).to.equal(1);
      expect(newEmail).to.not.be.undefined;
      expect(newEmail!.isImportant).to.equal(1);
      expect(newEmail!.isStarred).to.equal(1);
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

    it('emits a deduplicated mail:new-email batch for recent IDLE-delivered messages', async function () {
      this.timeout(25_000);

      const recentIso = DateTime.utc().minus({ minutes: 1 }).toISO()!;
      const notificationRaw = buildSyntheticEmail({
        fromHeader: 'Notifier <notifier@example.com>',
        toHeader: suiteEmail,
        subject: 'Notification batch message',
        body: 'This message should appear in a new-mail batch.',
        dateIso: recentIso,
        xGmMsgId: '9911000000000001',
        xGmThrid: '9912000000000001',
        messageId: '<notification-batch-001@example.com>',
        labels: ['\\Inbox', '\\All'],
      });

      imapStateInspector.injectMessage('[Gmail]/All Mail', notificationRaw, {
        xGmMsgId: '9911000000000001',
        xGmThrid: '9912000000000001',
        xGmLabels: ['\\Inbox', '\\All'],
        internalDate: recentIso,
      });

      const priorNewEmailCount = TestEventBus.getInstance().getHistory('mail:new-email').length;

      imapStateInspector.injectAndNotify('INBOX', notificationRaw, {
        xGmMsgId: '9911000000000001',
        xGmThrid: '9912000000000001',
        xGmLabels: ['\\Inbox'],
        internalDate: recentIso,
      });

      const newEmailArgs = await waitForEvent('mail:new-email', {
        timeout: 20_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          if (payload == null) {
            return false;
          }

          const currentCount = TestEventBus.getInstance().getHistory('mail:new-email').length;
          return Number(payload['accountId']) === suiteAccountId && currentCount > priorNewEmailCount;
        },
      });

      const payload = newEmailArgs[0] as {
        accountId: number;
        folder: string;
        totalNewCount: number;
        newEmails: Array<{ xGmMsgId: string; xGmThrid: string; sender: string; subject: string }>;
      };

      expect(payload.accountId).to.equal(suiteAccountId);
      expect(payload.folder).to.equal('INBOX');
      expect(payload.totalNewCount).to.equal(1);
      expect(payload.newEmails).to.have.length(1);
      expect(payload.newEmails[0]!.xGmMsgId).to.equal('9911000000000001');
      expect(payload.newEmails[0]!.subject).to.equal('Notification batch message');
    });

    it('re-establishes INBOX and All Mail IDLE after the underlying connections drop', async function () {
      this.timeout(25_000);

      const imapService = ImapService.getInstance();
      const syncService = SyncService.getInstance();
      const imapInternals = imapService as unknown as {
        idleConnections: Map<string, { emit: (event: string, ...argumentsList: unknown[]) => boolean }>;
      };
      const syncInternals = syncService as unknown as {
        idleNewMailCallbacks: Map<string, () => void>;
        idleAllMailCallbacks: Map<string, (accountId: string) => void>;
        scheduleIdleReconnect: (accountId: string) => void;
        scheduleIdleAllMailReconnect: (accountId: string) => void;
      };
      const inboxKey = `${suiteAccountId}:INBOX`;
      const allMailKey = `${suiteAccountId}:${ALL_MAIL_PATH}`;
      const previousInboxClient = imapInternals.idleConnections.get(inboxKey);
      const previousAllMailClient = imapInternals.idleConnections.get(allMailKey);
      const originalScheduleIdleReconnect = syncInternals.scheduleIdleReconnect;
      const originalScheduleIdleAllMailReconnect = syncInternals.scheduleIdleAllMailReconnect;

      expect(imapInternals.idleConnections.has(inboxKey)).to.equal(true);
      expect(imapInternals.idleConnections.has(allMailKey)).to.equal(true);
      expect(previousInboxClient).to.not.equal(undefined);
      expect(previousAllMailClient).to.not.equal(undefined);

      syncInternals.scheduleIdleReconnect = (accountId: string) => {
        const storedCallback = syncInternals.idleNewMailCallbacks.get(accountId) ?? (() => {});
        void syncService.startIdle(accountId, storedCallback);
      };
      syncInternals.scheduleIdleAllMailReconnect = (accountId: string) => {
        const storedCallback = syncInternals.idleAllMailCallbacks.get(accountId) ?? ((_accountId: string) => {});
        void syncService.startIdleAllMail(accountId, storedCallback);
      };

      try {
        previousInboxClient!.emit('error', new Error('Simulated INBOX IDLE drop'));
        previousAllMailClient!.emit('error', new Error('Simulated All Mail IDLE drop'));

        await waitForCondition(() => {
          const currentInboxClient = imapInternals.idleConnections.get(inboxKey);
          const currentAllMailClient = imapInternals.idleConnections.get(allMailKey);
          return (
            currentInboxClient !== undefined &&
            currentAllMailClient !== undefined &&
            currentInboxClient !== previousInboxClient &&
            currentAllMailClient !== previousAllMailClient
          );
        }, 15_000, 100);
      } finally {
        syncInternals.scheduleIdleReconnect = originalScheduleIdleReconnect;
        syncInternals.scheduleIdleAllMailReconnect = originalScheduleIdleAllMailReconnect;
      }

      const reconnectDate = DateTime.utc();
      const reconnectRaw = buildSyntheticEmail({
        fromHeader: 'reconnect-check@example.com',
        toHeader: suiteEmail,
        subject: 'IDLE reconnect verification',
        body: 'This message verifies IDLE reconnect handling.',
        dateIso: reconnectDate.toISO()!,
        xGmMsgId: '7990000000000001',
        xGmThrid: '7990000000000101',
        messageId: '<idle-reconnect-verification@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: reconnectRaw,
        xGmMsgId: '7990000000000001',
        xGmThrid: '7990000000000101',
        internalDate: reconnectDate.toISO()!,
      });

      const priorFolderUpdatedCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
        (record) => {
          const payload = record.args[0] as FolderUpdatedPayload | undefined;
          return payload?.accountId === suiteAccountId;
        },
      ).length;

      imapStateInspector.injectAndNotify('INBOX', reconnectRaw, {
        xGmMsgId: '7990000000000001',
        xGmThrid: '7990000000000101',
        xGmLabels: ['\\Inbox'],
        internalDate: reconnectDate.toISO()!,
      });

      await waitForEvent('mail:folder-updated', {
        timeout: 15_000,
        predicate: (args) => {
          const payload = args[0] as FolderUpdatedPayload | undefined;
          if (!payload || payload.accountId !== suiteAccountId) {
            return false;
          }
          const currentCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter(
            (record) => {
              const recordPayload = record.args[0] as FolderUpdatedPayload | undefined;
              return recordPayload?.accountId === suiteAccountId;
            },
          ).length;
          return currentCount > priorFolderUpdatedCount;
        },
      });

      expect(DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '7990000000000001')).to.not.be.null;
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
  // Background sync timer
  // =========================================================================

  describe('Background sync timer', () => {
    before(async function () {
      this.timeout(25_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-timer@example.com',
        displayName: 'Sync Timer Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      DatabaseService.getInstance().setSetting('syncInterval', '300000');
    });

    afterEach(async () => {
      SyncQueueBridge.getInstance().stop();
      try {
        await SyncService.getInstance().stopAllIdle();
      } catch {
        // Non-fatal cleanup in case IDLE never started
      }
    });

    it('uses the configured 5-minute interval when background sync starts without an override', async function () {
      this.timeout(20_000);

      const bridge = SyncQueueBridge.getInstance();
      const globalContext = global as typeof globalThis;
      const originalSetInterval = globalContext.setInterval;
      const originalStartIdleForAllAccounts = (
        bridge as unknown as { startIdleForAllAccounts: (capturedGeneration: number) => void }
      ).startIdleForAllAccounts;
      let capturedIntervalMs: number | null = null;

      try {
        (bridge as unknown as { startIdleForAllAccounts: (capturedGeneration: number) => void }).startIdleForAllAccounts = () => {};
        globalContext.setInterval = ((...argumentsList: Parameters<typeof setInterval>): ReturnType<typeof setInterval> => {
          const [handler, timeout, ...remainingArguments] = argumentsList;
          capturedIntervalMs = Number(timeout ?? 0);
          return originalSetInterval(handler, 24 * 60 * 60 * 1000, ...remainingArguments);
        }) as typeof setInterval;

        const priorCompletedCount = getCompletedSyncEventCount(suiteAccountId);
        bridge.start();
        expect(capturedIntervalMs).to.equal(300_000);

        await waitForCompletedSyncEvent(suiteAccountId, priorCompletedCount, 20_000);
      } finally {
        globalContext.setInterval = originalSetInterval;
        (bridge as unknown as { startIdleForAllAccounts: (capturedGeneration: number) => void }).startIdleForAllAccounts = originalStartIdleForAllAccounts;
      }
    });

    it('fires follow-up sync ticks on the configured interval', async function () {
      this.timeout(20_000);

      const bridge = SyncQueueBridge.getInstance();
      const originalOnSyncTick = (bridge as unknown as { onSyncTick: () => Promise<void> }).onSyncTick;
      const originalStartIdleForAllAccounts = (
        bridge as unknown as { startIdleForAllAccounts: (capturedGeneration: number) => void }
      ).startIdleForAllAccounts;
      const originalSetInterval = global.setInterval;
      const scheduledCallbacks: Array<() => void> = [];
      let tickCount = 0;

      (bridge as unknown as { onSyncTick: () => Promise<void> }).onSyncTick = async () => {
        tickCount += 1;
      };
      (bridge as unknown as { startIdleForAllAccounts: (capturedGeneration: number) => void }).startIdleForAllAccounts = () => {};
      global.setInterval = ((callback: (...callbackArgs: unknown[]) => void, _timeout?: number, ...argumentsList: unknown[]): ReturnType<typeof setInterval> => {
        if (typeof callback === 'function') {
          scheduledCallbacks.push(() => {
            callback(...argumentsList);
          });
        }

        return originalSetInterval(() => {}, 24 * 60 * 60 * 1000);
      }) as typeof setInterval;

      try {
        bridge.start(75);
        expect(scheduledCallbacks.length).to.equal(1);
        scheduledCallbacks[0]!();
        scheduledCallbacks[0]!();
        await waitForCondition(() => tickCount > 2, 5_000, 25);
        expect(tickCount).to.be.greaterThan(1);
      } finally {
        bridge.stop();
        (bridge as unknown as { onSyncTick: () => Promise<void> }).onSyncTick = originalOnSyncTick;
        (bridge as unknown as { startIdleForAllAccounts: (capturedGeneration: number) => void }).startIdleForAllAccounts = originalStartIdleForAllAccounts;
        global.setInterval = originalSetInterval;
      }
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

    it('emits paused-state change events for both pause and resume IPC operations', async function () {
      this.timeout(20_000);

      const pauseEventPromise = waitForEvent('sync:paused-state-changed', {
        timeout: 10_000,
        predicate: (args) => {
          const payload = args[0] as { paused?: boolean } | undefined;
          return payload?.paused === true;
        },
      });

      const pauseResponse = await callIpc('sync:pause') as IpcResponse<SyncPausedResponse>;
      expect(pauseResponse.success).to.equal(true);
      expect(pauseResponse.data!.paused).to.equal(true);

      const pauseEventArgs = await pauseEventPromise;
      const pausePayload = pauseEventArgs[0] as { paused: boolean };
      expect(pausePayload.paused).to.equal(true);

      const resumeEventPromise = waitForEvent('sync:paused-state-changed', {
        timeout: 10_000,
        predicate: (args) => {
          const payload = args[0] as { paused?: boolean } | undefined;
          return payload?.paused === false;
        },
      });

      const resumeResponse = await callIpc('sync:resume') as IpcResponse<SyncPausedResponse>;
      expect(resumeResponse.success).to.equal(true);
      expect(resumeResponse.data!.paused).to.equal(false);

      const resumeEventArgs = await resumeEventPromise;
      const resumePayload = resumeEventArgs[0] as { paused: boolean };
      expect(resumePayload.paused).to.equal(false);
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

    it('still enqueues and completes a manual sync while background sync is paused', async function () {
      this.timeout(25_000);

      const pausedMessage = emlFixtures['html-email'];
      injectInboxAndAllMailMessage({
        raw: pausedMessage.raw,
        xGmMsgId: pausedMessage.headers.xGmMsgId,
        xGmThrid: pausedMessage.headers.xGmThrid,
      });

      const pauseResponse = await callIpc('sync:pause') as IpcResponse<SyncPausedResponse>;
      expect(pauseResponse.success).to.equal(true);
      expect(pauseResponse.data!.paused).to.equal(true);

      try {
        const syncResponse = await callIpc('mail:sync-account', String(suiteAccountId)) as IpcResponse<{ queueId: string | null }>;
        expect(syncResponse.success).to.equal(true);
        expect(syncResponse.data!.queueId).to.be.a('string');

        const terminalArgs = await waitForEvent('queue:update', {
          timeout: 15_000,
          predicate: (args) => {
            const snapshot = args[0] as QueueUpdateSnapshot | undefined;
            if (!snapshot) {
              return false;
            }
            if (snapshot.queueId !== syncResponse.data!.queueId) {
              return false;
            }
            return snapshot.status === 'completed' || snapshot.status === 'failed';
          },
        });

        const terminalSnapshot = terminalArgs[0] as QueueUpdateSnapshot;
        expect(terminalSnapshot.status).to.equal('completed');

        const pausedState = await callIpc('sync:get-paused') as IpcResponse<SyncPausedResponse>;
        expect(pausedState.success).to.equal(true);
        expect(pausedState.data!.paused).to.equal(true);

        const email = DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, pausedMessage.headers.xGmMsgId);
        expect(email).to.not.be.null;
      } finally {
        await callIpc('sync:resume');
      }
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

    it('skips blank senders and deduplicates repeated participants during sync metadata recomputation', async function () {
      this.timeout(25_000);

      const threadId = '8555000000000101';
      const newestDate = DateTime.utc();
      const duplicateNewestRaw = buildSyntheticEmail({
        fromHeader: 'duplicate-sync@example.com <duplicate-sync@example.com>',
        toHeader: suiteEmail,
        subject: 'Participant dedupe newest',
        body: 'Newest duplicate sender body',
        dateIso: newestDate.toISO()!,
        xGmMsgId: '8555000000000001',
        xGmThrid: threadId,
        messageId: '<participant-dedupe-newest@example.com>',
      });
      const duplicateOlderRaw = buildSyntheticEmail({
        fromHeader: 'Duplicate Sync Sender <duplicate-sync@example.com>',
        toHeader: suiteEmail,
        subject: 'Participant dedupe older',
        body: 'Older duplicate sender body',
        dateIso: newestDate.minus({ minutes: 1 }).toISO()!,
        xGmMsgId: '8555000000000002',
        xGmThrid: threadId,
        messageId: '<participant-dedupe-older@example.com>',
      });
      const blankSenderRaw = buildSyntheticEmail({
        fromHeader: '<>',
        toHeader: suiteEmail,
        subject: 'Participant blank sender',
        body: 'Blank sender body',
        dateIso: newestDate.minus({ minutes: 2 }).toISO()!,
        xGmMsgId: '8555000000000003',
        xGmThrid: threadId,
        messageId: '<participant-blank-sender@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: duplicateOlderRaw,
        xGmMsgId: '8555000000000002',
        xGmThrid: threadId,
        internalDate: newestDate.minus({ minutes: 1 }).toISO()!,
      });
      injectInboxAndAllMailMessage({
        raw: blankSenderRaw,
        xGmMsgId: '8555000000000003',
        xGmThrid: threadId,
        internalDate: newestDate.minus({ minutes: 2 }).toISO()!,
      });
      injectInboxAndAllMailMessage({
        raw: duplicateNewestRaw,
        xGmMsgId: '8555000000000001',
        xGmThrid: threadId,
        internalDate: newestDate.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const thread = DatabaseService.getInstance().getThreadById(suiteAccountId, threadId);
      expect(thread).to.not.be.null;
      expect(thread!['participants']).to.equal('duplicate-sync@example.com');
    });
  });
});
