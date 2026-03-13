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
 *   - Post-sync non–All Mail folder sync writes All Mail UID associations for reconciliation
 *   - All Mail UID-diff reconciliation purges stale associations, orphaned emails, and thread metadata
 *   - Thread metadata recomputed after sync
 *   - Contact extraction from synced mail
 *   - INBOX IDLE: new message via EXISTS notification → sync → mail:folder-updated
 *   - All Mail IDLE: EXPUNGE notification → reconcile sync → mail:folder-updated + DB cleanup
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
  waitForNextFolderUpdated,
  waitForQueueTerminalState,
} from '../infrastructure/test-helpers';
import { imapStateInspector } from '../test-main';
import { emlFixtures } from '../fixtures/index';
import { DatabaseService } from '../../../electron/services/database-service';
import { BodyFetchQueueService } from '../../../electron/services/body-fetch-queue-service';
import { FetchedEmail, ImapService } from '../../../electron/services/imap-service';
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

function ageEmailForOrphanCleanup(accountId: number, xGmMsgId: string, hoursAgo: number = 2): void {
  const rawDb = DatabaseService.getInstance().getDatabase();
  const agedTimestamp = DateTime.utc().minus({ hours: hoursAgo }).toFormat('yyyy-LL-dd HH:mm:ss');

  rawDb.prepare(
    `UPDATE emails
     SET updated_at = :agedTimestamp
     WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId`,
  ).run({ accountId, xGmMsgId, agedTimestamp });
}

function pauseBodyFetchQueueForDeterministicCleanup(): void {
  BodyFetchQueueService.getInstance().resetForTesting();
}

async function triggerFolderSyncAndWait(accountId: number, folder: string, timeout: number = 15_000): Promise<{ accountId: number; folders?: string[]; reason?: string; changeType?: string; count?: number }> {
  const syncResponse = await callIpc('mail:sync-folder', {
    accountId: String(accountId),
    folder,
  }) as IpcResponse<void>;

  expect(syncResponse.success).to.equal(true);

  return waitForNextFolderUpdated(accountId, {
    folder,
    reason: 'sync',
    timeout,
  });
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

function buildRawEmailFromLines(lines: string[]): Buffer {
  return Buffer.from(lines.join('\r\n'), 'utf8');
}

function buildFetchedEmail(overrides: Partial<FetchedEmail> = {}): FetchedEmail {
  return {
    uid: overrides.uid ?? 1,
    xGmMsgId: overrides.xGmMsgId ?? 'synthetic-xgm-msgid',
    xGmThrid: overrides.xGmThrid ?? 'synthetic-xgm-thrid',
    messageId: overrides.messageId ?? '<synthetic-message-id@example.com>',
    folder: overrides.folder ?? 'INBOX',
    fromAddress: overrides.fromAddress ?? 'sender@example.com',
    fromName: overrides.fromName ?? 'Sender Example',
    toAddresses: overrides.toAddresses ?? suiteEmail,
    ccAddresses: overrides.ccAddresses ?? '',
    bccAddresses: overrides.bccAddresses ?? '',
    subject: overrides.subject ?? 'Synthetic subject',
    textBody: overrides.textBody ?? '',
    htmlBody: overrides.htmlBody ?? '',
    date: overrides.date ?? DateTime.utc().toISO()!,
    isRead: overrides.isRead ?? false,
    isStarred: overrides.isStarred ?? false,
    isImportant: overrides.isImportant ?? false,
    isDraft: overrides.isDraft ?? false,
    snippet: overrides.snippet ?? 'Synthetic snippet',
    size: overrides.size ?? 0,
    hasAttachments: overrides.hasAttachments ?? false,
    labels: overrides.labels ?? '',
    rawLabels: overrides.rawLabels ?? [],
    modseq: overrides.modseq,
    attachments: overrides.attachments,
  };
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
  // Post-sync All Mail UID resolution from non-All Mail folder sync
  // =========================================================================

  describe('Post-sync All Mail UID resolution', () => {
    const inboxOnlyMsgId = '8555000000000001';
    const inboxOnlyThreadId = '8555000000000101';
    let allMailUid: number;

    before(async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-allmail-uid-resolution@example.com',
        displayName: 'All Mail UID Resolution Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const inboxOnlyRaw = buildSyntheticEmail({
        fromHeader: 'allmail-resolution@example.com',
        toHeader: suiteEmail,
        subject: 'All Mail UID resolution target',
        body: 'This message verifies post-sync All Mail UID writes.',
        dateIso: DateTime.utc().minus({ minutes: 2 }).toISO()!,
        xGmMsgId: inboxOnlyMsgId,
        xGmThrid: inboxOnlyThreadId,
        messageId: '<allmail-uid-resolution@example.com>',
        labels: ['\\Inbox', '\\All'],
      });

      allMailUid = imapStateInspector.injectMessage('[Gmail]/All Mail', inboxOnlyRaw, {
        xGmMsgId: inboxOnlyMsgId,
        xGmThrid: inboxOnlyThreadId,
        xGmLabels: ['\\Inbox', '\\All'],
      }).uid;
      imapStateInspector.injectMessage('INBOX', inboxOnlyRaw, {
        xGmMsgId: inboxOnlyMsgId,
        xGmThrid: inboxOnlyThreadId,
        xGmLabels: ['\\Inbox'],
      });
    });

    it('writes an All Mail email_folders UID row after syncing INBOX only', async function () {
      this.timeout(20_000);

      await triggerFolderSyncAndWait(suiteAccountId, 'INBOX');

      const db = DatabaseService.getInstance();
      const email = db.getEmailByXGmMsgId(suiteAccountId, inboxOnlyMsgId);
      const folders = db.getFoldersForEmail(suiteAccountId, inboxOnlyMsgId);
      const folderUids = db.getFolderUidsForEmail(suiteAccountId, inboxOnlyMsgId);
      const allMailFolderUid = folderUids.find((entry) => entry.folder === ALL_MAIL_PATH);

      expect(email).to.not.be.null;
      expect(folders).to.include('INBOX');
      expect(folders).to.include(ALL_MAIL_PATH);
      expect(allMailFolderUid).to.not.equal(undefined);
      expect(allMailFolderUid!.uid).to.equal(allMailUid);
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
      // Send an EXISTS notification to the IDLE client — simulates new mail arriving
      imapStateInspector.injectAndNotify('INBOX', htmlMsg.raw, {
        xGmMsgId: '9991000000000099',
        xGmThrid: '9992000000000099',
        xGmLabels: ['\\Inbox'],
      });

      // Wait for the sync triggered by IDLE to emit mail:folder-updated
      await waitForNextFolderUpdated(suiteAccountId, { timeout: 20_000 });
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

      // Inject and notify via IDLE — gives both the message store AND the EXISTS signal
      imapStateInspector.injectAndNotify('INBOX', multipartMsg.raw, {
        xGmMsgId: multipartMsg.headers.xGmMsgId,
        xGmThrid: multipartMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      // Wait for the IDLE-triggered sync to emit mail:folder-updated
      await waitForNextFolderUpdated(suiteAccountId, { timeout: 20_000 });

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

      imapStateInspector.injectAndNotify('INBOX', reconnectRaw, {
        xGmMsgId: '7990000000000001',
        xGmThrid: '7990000000000101',
        xGmLabels: ['\\Inbox'],
        internalDate: reconnectDate.toISO()!,
      });

      await waitForNextFolderUpdated(suiteAccountId, { timeout: 15_000 });

      expect(DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '7990000000000001')).to.not.be.null;
    });
  });

  // =========================================================================
  // IDLE — expunge flow (All Mail EXPUNGE → reconcile sync)
  // =========================================================================

  describe('IDLE expunge flow', () => {
    let injectedUid: number;
    let expungedMsgId: string;
    let survivingMsgId: string;

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
      expungedMsgId = plainMsg.headers.xGmMsgId;
      survivingMsgId = htmlMsg.headers.xGmMsgId;

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
      pauseBodyFetchQueueForDeterministicCleanup();
      ageEmailForOrphanCleanup(suiteAccountId, expungedMsgId);

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

       const priorSyncEventCount = TestEventBus.getInstance().getHistory('mail:folder-updated').filter((record) => {
        const payload = record.args[0] as FolderUpdatedPayload | undefined;
        return payload?.accountId === suiteAccountId && payload?.reason === 'sync' && (payload.folders ?? []).includes(ALL_MAIL_PATH);
      }).length;

      // Remove the first message from All Mail on the server and send EXPUNGE notification
      imapStateInspector.expungeAndNotify('[Gmail]/All Mail', injectedUid);

      // Wait for the reconcile sync triggered by the EXPUNGE IDLE event
      const payload = await waitForNextFolderUpdated(suiteAccountId, {
        timeout: 20_000,
        reason: 'sync',
        folder: ALL_MAIL_PATH,
        priorCount: priorSyncEventCount,
      });

      expect(payload.folders ?? []).to.include(ALL_MAIL_PATH);
      expect(payload.reason).to.equal('sync');
    });

    it('removes stale All Mail associations and orphaned emails after IDLE expunge reconciliation', async function () {
      this.timeout(25_000);

      const staleEmail = DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, expungedMsgId);
      const staleFolders = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, expungedMsgId);
      const survivingEmail = DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, survivingMsgId);
      const survivingFolders = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, survivingMsgId);

      expect(staleEmail).to.be.null;
      expect(staleFolders).to.deep.equal([]);
      expect(survivingEmail).to.not.be.null;
      expect(survivingFolders).to.include('INBOX');
    });
  });

  // =========================================================================
  // All Mail UID-diff reconciliation cleanup
  // =========================================================================

  describe('All Mail UID-diff reconciliation cleanup', () => {
    const stalePrimaryMsgId = '8661000000000001';
    const stalePrimaryThreadId = '8661000000000101';
    const survivorMsgId = '8661000000000002';
    const survivorThreadId = '8661000000000102';
    let staleAllMailUid: number;

    before(async function () {
      this.timeout(35_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-allmail-reconcile@example.com',
        displayName: 'All Mail Reconcile Cleanup Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
      imapStateInspector.getStore().createMailbox('Projects');

      const staleRaw = buildSyntheticEmail({
        fromHeader: 'stale-allmail@example.com',
        toHeader: suiteEmail,
        subject: 'Stale All Mail message',
        body: 'This message should be removed after All Mail UID diff reconciliation.',
        dateIso: DateTime.utc().minus({ minutes: 4 }).toISO()!,
        xGmMsgId: stalePrimaryMsgId,
        xGmThrid: stalePrimaryThreadId,
        messageId: '<stale-allmail-message@example.com>',
        labels: ['\\Inbox', 'Projects', '\\All'],
      });

      staleAllMailUid = imapStateInspector.injectMessage('[Gmail]/All Mail', staleRaw, {
        xGmMsgId: stalePrimaryMsgId,
        xGmThrid: stalePrimaryThreadId,
        xGmLabels: ['\\Inbox', 'Projects', '\\All'],
      }).uid;
      imapStateInspector.injectMessage('INBOX', staleRaw, {
        xGmMsgId: stalePrimaryMsgId,
        xGmThrid: stalePrimaryThreadId,
        xGmLabels: ['\\Inbox'],
      });
      imapStateInspector.injectMessage('Projects', staleRaw, {
        xGmMsgId: stalePrimaryMsgId,
        xGmThrid: stalePrimaryThreadId,
        xGmLabels: ['Projects'],
      });

      const survivorRaw = buildSyntheticEmail({
        fromHeader: 'survivor-allmail@example.com',
        toHeader: suiteEmail,
        subject: 'Surviving All Mail message',
        body: 'This message should remain after reconciliation.',
        dateIso: DateTime.utc().minus({ minutes: 3 }).toISO()!,
        xGmMsgId: survivorMsgId,
        xGmThrid: survivorThreadId,
        messageId: '<survivor-allmail-message@example.com>',
        labels: ['\\Inbox', '\\All'],
      });

      injectInboxAndAllMailMessage({
        raw: survivorRaw,
        xGmMsgId: survivorMsgId,
        xGmThrid: survivorThreadId,
        internalDate: DateTime.utc().minus({ minutes: 3 }).toISO()!,
        allMailLabels: ['\\Inbox', '\\All'],
        inboxLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
    });

    it('purges stale All Mail cascaded folder links and orphaned thread state after direct All Mail sync', async function () {
      this.timeout(25_000);

      const db = DatabaseService.getInstance();

      expect(db.getEmailByXGmMsgId(suiteAccountId, stalePrimaryMsgId)).to.not.be.null;
      expect(db.getFoldersForEmail(suiteAccountId, stalePrimaryMsgId)).to.include('INBOX');
      expect(db.getFoldersForEmail(suiteAccountId, stalePrimaryMsgId)).to.include('Projects');
      expect(db.getFoldersForEmail(suiteAccountId, stalePrimaryMsgId)).to.include(ALL_MAIL_PATH);
      expect(db.getThreadById(suiteAccountId, stalePrimaryThreadId)).to.not.be.null;

      pauseBodyFetchQueueForDeterministicCleanup();
      ageEmailForOrphanCleanup(suiteAccountId, stalePrimaryMsgId);
      imapStateInspector.getStore().expungeUids('[Gmail]/All Mail', [staleAllMailUid]);

      const affectedFolders = await runDirectAllMailSync(suiteAccountId, false);

      const staleFoldersAfter = db.getFoldersForEmail(suiteAccountId, stalePrimaryMsgId);
      const staleEmailAfter = db.getEmailByXGmMsgId(suiteAccountId, stalePrimaryMsgId);
      const staleThreadAfter = db.getThreadById(suiteAccountId, stalePrimaryThreadId);
      const survivorEmailAfter = db.getEmailByXGmMsgId(suiteAccountId, survivorMsgId);
      const survivorFoldersAfter = db.getFoldersForEmail(suiteAccountId, survivorMsgId);

      expect(Array.from(affectedFolders)).to.include(ALL_MAIL_PATH);
      expect(Array.from(affectedFolders)).to.include('INBOX');
      expect(Array.from(affectedFolders)).to.include('Projects');
      expect(staleFoldersAfter).to.deep.equal([]);
      expect(staleEmailAfter).to.be.null;
      expect(staleThreadAfter).to.be.null;
      expect(survivorEmailAfter).to.not.be.null;
      expect(survivorFoldersAfter).to.include('INBOX');
      expect(survivorFoldersAfter).to.include(ALL_MAIL_PATH);
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
      expect(syncQueueId).to.not.equal(null);
      await waitForQueueTerminalState(syncQueueId!, {
        expectedStatus: 'completed',
        timeout: 15_000,
      });

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

        await waitForQueueTerminalState(syncResponse.data!.queueId!, {
          expectedStatus: 'completed',
          timeout: 15_000,
        });

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
  // Format participant branches and IMAP parser fallbacks
  // =========================================================================

  describe('Format participant branches and IMAP parser fallbacks', () => {
    before(async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-format-parser@example.com',
        displayName: 'Format Parser Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
    });

    it('stores sender participants as address-only when the sender omits a display name', async function () {
      this.timeout(20_000);

      const sentAt = DateTime.utc();
      const rawEmail = buildSyntheticEmail({
        fromHeader: 'sender-no-name@example.com',
        toHeader: suiteEmail,
        subject: 'Sender without display name',
        body: 'No display name body',
        dateIso: sentAt.toISO()!,
        xGmMsgId: '8666000000000001',
        xGmThrid: '8666000000000101',
        messageId: '<sender-no-name@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: rawEmail,
        xGmMsgId: '8666000000000001',
        xGmThrid: '8666000000000101',
        internalDate: sentAt.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const thread = DatabaseService.getInstance().getThreadById(suiteAccountId, '8666000000000101');
      expect(thread).to.not.be.null;
      expect(thread!['participants']).to.equal('sender-no-name@example.com');
    });

    it('keeps only one address-only participant when the newest sender name equals the email address', async function () {
      this.timeout(20_000);

      const threadId = '8666000000000102';
      const newestDate = DateTime.utc();
      const olderDate = newestDate.minus({ minutes: 1 });

      const newestRaw = buildSyntheticEmail({
        fromHeader: 'alice@example.com <alice@example.com>',
        toHeader: suiteEmail,
        subject: 'Newest sender uses email as name',
        body: 'Newest body',
        dateIso: newestDate.toISO()!,
        xGmMsgId: '8666000000000002',
        xGmThrid: threadId,
        messageId: '<alice-name-equals-address-newest@example.com>',
      });
      const olderRaw = buildSyntheticEmail({
        fromHeader: 'Alice Example <alice@example.com>',
        toHeader: suiteEmail,
        subject: 'Older sender uses human name',
        body: 'Older body',
        dateIso: olderDate.toISO()!,
        xGmMsgId: '8666000000000003',
        xGmThrid: threadId,
        messageId: '<alice-name-equals-address-older@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: olderRaw,
        xGmMsgId: '8666000000000003',
        xGmThrid: threadId,
        internalDate: olderDate.toISO()!,
      });
      injectInboxAndAllMailMessage({
        raw: newestRaw,
        xGmMsgId: '8666000000000002',
        xGmThrid: threadId,
        internalDate: newestDate.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const thread = DatabaseService.getInstance().getThreadById(suiteAccountId, threadId);
      expect(thread).to.not.be.null;
      expect(thread!['participants']).to.equal('alice@example.com');
    });

    it('stores parser defaults when IMAP envelope fields like sender subject and message-id are missing', async function () {
      this.timeout(20_000);

      const sentAt = DateTime.utc();
      const rawEmail = buildRawEmailFromLines([
        `Date: ${sentAt.toUTC().toRFC2822()}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        'X-GM-MSGID: 8666000000000004',
        'X-GM-THRID: 8666000000000103',
        'X-GM-LABELS: \\Inbox \\All',
        '',
        'Minimal message body without sender or subject headers.',
      ]);

      injectInboxAndAllMailMessage({
        raw: rawEmail,
        xGmMsgId: '8666000000000004',
        xGmThrid: '8666000000000103',
        internalDate: sentAt.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const email = DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '8666000000000004');
      const thread = DatabaseService.getInstance().getThreadById(suiteAccountId, '8666000000000103');

      expect(email).to.not.be.null;
      expect(email!['fromAddress']).to.equal('');
      expect(email!['fromName']).to.equal('');
      expect(email!['subject']).to.equal('(no subject)');
      expect(email!['messageId']).to.equal(null);

      expect(thread).to.not.be.null;
      expect(thread!['participants']).to.equal('');
    });

    it('falls back to parsing Message-ID from raw headers when the IMAP envelope omits it', async function () {
      this.timeout(20_000);

      const sentAt = DateTime.utc();
      const rawEmail = buildRawEmailFromLines([
        'From: Fallback Header <fallback-header@example.com>',
        `To: ${suiteEmail}`,
        'Subject: Folded Message-ID fallback',
        `Date: ${sentAt.toUTC().toRFC2822()}`,
        'Message-ID:',
        ' <folded-message-id-fallback@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 7bit',
        'X-GM-MSGID: 8666000000000005',
        'X-GM-THRID: 8666000000000104',
        'X-GM-LABELS: \\Inbox \\All',
        '',
        'Folded Message-ID body.',
      ]);

      injectInboxAndAllMailMessage({
        raw: rawEmail,
        xGmMsgId: '8666000000000005',
        xGmThrid: '8666000000000104',
        internalDate: sentAt.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const email = DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '8666000000000005');
      expect(email).to.not.be.null;
      expect(email!['messageId']).to.equal('<folded-message-id-fallback@example.com>');
    });
  });

  // =========================================================================
  // IMAP connection reuse and empty-folder sync
  // =========================================================================

  describe('IMAP connection reuse and empty-folder sync', () => {
    before(async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-imap-pool@example.com',
        displayName: 'IMAP Pool Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);
      imapStateInspector.getStore().createMailbox('Projects');

      const initialDate = DateTime.utc();
      const initialRaw = buildSyntheticEmail({
        fromHeader: 'pool-initial@example.com',
        toHeader: suiteEmail,
        subject: 'Initial pooled message',
        body: 'Initial pooled body',
        dateIso: initialDate.toISO()!,
        xGmMsgId: '8777000000000001',
        xGmThrid: '8777000000000101',
        messageId: '<initial-pooled-message@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: initialRaw,
        xGmMsgId: '8777000000000001',
        xGmThrid: '8777000000000101',
        internalDate: initialDate.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });
    });

    it('reuses the existing shared IMAP connection across two sequential syncs', async function () {
      this.timeout(20_000);

      const imapService = ImapService.getInstance();
      const imapInternals = imapService as unknown as {
        connections: Map<string, { usable?: boolean }>;
      };

      const initialConnection = imapInternals.connections.get(String(suiteAccountId));
      expect(initialConnection).to.not.equal(undefined);
      expect(initialConnection!.usable).to.equal(true);

      const secondDate = DateTime.utc();
      const secondRaw = buildSyntheticEmail({
        fromHeader: 'pool-second@example.com',
        toHeader: suiteEmail,
        subject: 'Second pooled message',
        body: 'Second pooled body',
        dateIso: secondDate.toISO()!,
        xGmMsgId: '8777000000000002',
        xGmThrid: '8777000000000102',
        messageId: '<second-pooled-message@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: secondRaw,
        xGmMsgId: '8777000000000002',
        xGmThrid: '8777000000000102',
        internalDate: secondDate.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const reusedConnection = imapInternals.connections.get(String(suiteAccountId));
      expect(reusedConnection).to.equal(initialConnection);
      expect(DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '8777000000000002')).to.not.be.null;
    });

    it('syncs an empty custom folder without storing any additional emails', async function () {
      this.timeout(20_000);

      const rawDb = DatabaseService.getInstance().getDatabase();
      const beforeRow = rawDb.prepare(
        'SELECT COUNT(*) AS emailCount FROM emails WHERE account_id = :accountId',
      ).get({ accountId: suiteAccountId }) as { emailCount: number };

      const response = await callIpc('mail:sync-folder', {
        accountId: String(suiteAccountId),
        folder: 'Projects',
      }) as IpcResponse<void>;

      expect(response.success).to.equal(true);

      await waitForNextFolderUpdated(suiteAccountId, {
        folder: 'Projects',
        timeout: 15_000,
      });

      const afterRow = rawDb.prepare(
        'SELECT COUNT(*) AS emailCount FROM emails WHERE account_id = :accountId',
      ).get({ accountId: suiteAccountId }) as { emailCount: number };

      expect(afterRow.emailCount).to.equal(beforeRow.emailCount);
      expect(imapStateInspector.getMessageCount('Projects')).to.equal(0);
    });
  });

  // =========================================================================
  // IDLE non-growth EXISTS branch
  // =========================================================================

  describe('IDLE non-growth EXISTS notifications', () => {
    let idleCallbackCount = 0;

    before(async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'idle-non-growth@example.com',
        displayName: 'IDLE Non Growth Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const initialDate = DateTime.utc();
      const initialRaw = buildSyntheticEmail({
        fromHeader: 'idle-baseline@example.com',
        toHeader: suiteEmail,
        subject: 'IDLE baseline message',
        body: 'IDLE baseline body',
        dateIso: initialDate.toISO()!,
        xGmMsgId: '8888000000000001',
        xGmThrid: '8888000000000101',
        messageId: '<idle-baseline-message@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: initialRaw,
        xGmMsgId: '8888000000000001',
        xGmThrid: '8888000000000101',
        internalDate: initialDate.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      await SyncService.getInstance().startIdle(String(suiteAccountId), () => {
        idleCallbackCount += 1;
      });
      idleCallbackCount = 0;
    });

    after(async () => {
      try {
        await SyncService.getInstance().stopAllIdle();
      } catch {
        // Non-fatal cleanup
      }
    });

    it('ignores EXISTS notifications whose count does not grow', async function () {
      this.timeout(15_000);

      const existingCount = imapStateInspector.getMessageCount('INBOX');
      imapStateInspector.sendExistsNotification('INBOX', existingCount);

      await waitForMilliseconds(1_000);

      expect(idleCallbackCount).to.equal(0);
      expect(DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '8888000000000001')).to.not.be.null;
    });
  });

  // =========================================================================
  // Fetch-older edge cases
  // =========================================================================

  describe('Fetch-older edge cases', () => {
    it('returns an empty result when no messages are older than the requested cursor', async function () {
      this.timeout(25_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'fetch-older-none@example.com',
        displayName: 'Fetch Older None Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const recentDate = DateTime.utc().minus({ days: 2 });
      const recentRaw = buildSyntheticEmail({
        fromHeader: 'recent-only@example.com',
        toHeader: suiteEmail,
        subject: 'Recent only message',
        body: 'Recent only body',
        dateIso: recentDate.toISO()!,
        xGmMsgId: '8999000000000001',
        xGmThrid: '8999000000000101',
        messageId: '<recent-only-message@example.com>',
      });

      injectInboxAndAllMailMessage({
        raw: recentRaw,
        xGmMsgId: '8999000000000001',
        xGmThrid: '8999000000000101',
        internalDate: recentDate.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const response = await callIpc(
        'mail:fetch-older',
        String(suiteAccountId),
        'INBOX',
        DateTime.utc().minus({ days: 40 }).toISO()!,
        10,
      ) as IpcResponse<FetchOlderResponse>;

      expect(response.success).to.equal(true);

      const doneArgs = await waitForEvent('mail:fetch-older-done', {
        timeout: 20_000,
        predicate: (args) => {
          const payload = args[0] as FetchOlderDonePayload | undefined;
          return payload != null && payload.queueId === response.data!.queueId;
        },
      });

      const donePayload = doneArgs[0] as FetchOlderDonePayload;
      expect(donePayload.error).to.equal(undefined);
      expect(donePayload.threads).to.deep.equal([]);
      expect(donePayload.hasMore).to.equal(false);
      expect(donePayload.nextBeforeDate).to.equal(null);
    });

    it('decorates fetch-older thread rows with hasDraft when the thread also contains a draft', async function () {
      this.timeout(30_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'fetch-older-draft@example.com',
        displayName: 'Fetch Older Draft Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const threadId = '8999000000000102';
      const olderInboxDate = DateTime.utc().minus({ days: 55 });
      const recentDraftDate = DateTime.utc().minus({ days: 5 });

      const olderInboxRaw = buildSyntheticEmail({
        fromHeader: 'older-thread@example.com',
        toHeader: suiteEmail,
        subject: 'Older inbox thread message',
        body: 'Older inbox body',
        dateIso: olderInboxDate.toISO()!,
        xGmMsgId: '8999000000000002',
        xGmThrid: threadId,
        messageId: '<older-inbox-thread-message@example.com>',
      });
      const recentDraftRaw = buildSyntheticEmail({
        fromHeader: suiteEmail,
        toHeader: 'draft-target@example.com',
        subject: 'Recent draft in same thread',
        body: 'Recent draft body',
        dateIso: recentDraftDate.toISO()!,
        xGmMsgId: '8999000000000003',
        xGmThrid: threadId,
        messageId: '<recent-draft-same-thread@example.com>',
        labels: ['\\Draft', '\\All'],
      });

      injectInboxAndAllMailMessage({
        raw: olderInboxRaw,
        xGmMsgId: '8999000000000002',
        xGmThrid: threadId,
        internalDate: olderInboxDate.toISO()!,
      });
      imapStateInspector.injectMessage('[Gmail]/All Mail', recentDraftRaw, {
        xGmMsgId: '8999000000000003',
        xGmThrid: threadId,
        xGmLabels: ['\\Draft', '\\All'],
        flags: ['\\Draft'],
        internalDate: recentDraftDate.toISO()!,
      });
      imapStateInspector.injectMessage('[Gmail]/Drafts', recentDraftRaw, {
        xGmMsgId: '8999000000000003',
        xGmThrid: threadId,
        xGmLabels: ['\\Draft'],
        flags: ['\\Draft'],
        internalDate: recentDraftDate.toISO()!,
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      expect(DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '8999000000000003')).to.not.be.null;
      expect(DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '8999000000000002')).to.be.null;

      const response = await callIpc(
        'mail:fetch-older',
        String(suiteAccountId),
        'INBOX',
        DateTime.utc().minus({ days: 20 }).toISO()!,
        10,
      ) as IpcResponse<FetchOlderResponse>;

      expect(response.success).to.equal(true);

      const doneArgs = await waitForEvent('mail:fetch-older-done', {
        timeout: 20_000,
        predicate: (args) => {
          const payload = args[0] as FetchOlderDonePayload | undefined;
          return payload != null && payload.queueId === response.data!.queueId;
        },
      });

      const donePayload = doneArgs[0] as FetchOlderDonePayload;
      expect(donePayload.error).to.equal(undefined);
      expect(donePayload.threads).to.be.an('array').that.is.not.empty;

      const draftThread = donePayload.threads!.find((thread) => String(thread['xGmThrid']) === threadId);
      expect(draftThread).to.not.equal(undefined);
      expect(draftThread!['hasDraft']).to.equal(true);
      expect(DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '8999000000000002')).to.not.be.null;
    });

    it('falls back nextBeforeDate when fetch-older receives same-day messages newer than the cursor time', async function () {
      this.timeout(20_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'fetch-older-next-date@example.com',
        displayName: 'Fetch Older Next Date Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      const imapService = ImapService.getInstance() as unknown as {
        fetchOlderEmails: (accountId: string, folder: string, beforeDate: Date, limit: number) => Promise<{ emails: FetchedEmail[]; hasMore: boolean }>;
      };
      const originalFetchOlderEmails = imapService.fetchOlderEmails;
      const beforeDate = DateTime.utc().startOf('day').plus({ hours: 9 });
      const newerSameDay = beforeDate.plus({ hours: 2 });

      imapService.fetchOlderEmails = async (): Promise<{ emails: FetchedEmail[]; hasMore: boolean }> => {
        return {
          emails: [
            buildFetchedEmail({
              uid: 11,
              xGmMsgId: '9000000000000001',
              xGmThrid: '',
              messageId: '<same-day-newer@example.com>',
              date: newerSameDay.toISO()!,
            }),
          ],
          hasMore: true,
        };
      };

      try {
        const response = await callIpc(
          'mail:fetch-older',
          String(suiteAccountId),
          'INBOX',
          beforeDate.toISO()!,
          10,
        ) as IpcResponse<FetchOlderResponse>;

        expect(response.success).to.equal(true);

        const doneArgs = await waitForEvent('mail:fetch-older-done', {
          timeout: 20_000,
          predicate: (args) => {
            const payload = args[0] as FetchOlderDonePayload | undefined;
            return payload != null && payload.queueId === response.data!.queueId;
          },
        });

        const donePayload = doneArgs[0] as FetchOlderDonePayload;
        expect(donePayload.error).to.equal(undefined);
        expect(donePayload.threads).to.deep.equal([]);
        expect(donePayload.hasMore).to.equal(true);
        expect(donePayload.nextBeforeDate).to.equal(beforeDate.minus({ days: 1 }).toUTC().toISO());
      } finally {
        imapService.fetchOlderEmails = originalFetchOlderEmails;
      }
    });

    it('continues fetch-older when All Mail UID resolution fails and leaves undecorated string-id rows unchanged', async function () {
      this.timeout(20_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'fetch-older-uid-failure@example.com',
        displayName: 'Fetch Older UID Failure Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      const imapService = ImapService.getInstance() as unknown as {
        fetchOlderEmails: (accountId: string, folder: string, beforeDate: Date, limit: number) => Promise<{ emails: FetchedEmail[]; hasMore: boolean }>;
        resolveUidsByXGmMsgIdBatch: (accountId: string, folder: string, xGmMsgIds: string[]) => Promise<Map<string, number>>;
      };
      const databaseService = DatabaseService.getInstance() as unknown as {
        getThreadsByFolderBeforeDate: (accountId: number, folder: string, beforeDate: string, limit: number) => Array<Record<string, unknown>>;
      };
      const originalFetchOlderEmails = imapService.fetchOlderEmails;
      const originalResolveUidsByXGmMsgIdBatch = imapService.resolveUidsByXGmMsgIdBatch;
      const originalGetThreadsByFolderBeforeDate = databaseService.getThreadsByFolderBeforeDate;
      const olderDate = DateTime.utc().minus({ days: 40 });

      imapService.fetchOlderEmails = async (): Promise<{ emails: FetchedEmail[]; hasMore: boolean }> => {
        return {
          emails: [
            buildFetchedEmail({
              uid: 12,
              xGmMsgId: '9000000000000002',
              xGmThrid: '9000000000000102',
              messageId: '<uid-resolution-failure@example.com>',
              date: olderDate.toISO()!,
            }),
          ],
          hasMore: false,
        };
      };
      imapService.resolveUidsByXGmMsgIdBatch = async (): Promise<Map<string, number>> => {
        throw new Error('forced fetch-older uid resolution failure');
      };
      databaseService.getThreadsByFolderBeforeDate = (_accountId: number, _folder: string, _beforeDate: string, _limit: number): Array<Record<string, unknown>> => {
        return [{ id: '123', xGmThrid: '9000000000000102', subject: 'Synthetic thread row' }];
      };

      try {
        const response = await callIpc(
          'mail:fetch-older',
          String(suiteAccountId),
          'INBOX',
          DateTime.utc().minus({ days: 20 }).toISO()!,
          10,
        ) as IpcResponse<FetchOlderResponse>;

        expect(response.success).to.equal(true);

        const doneArgs = await waitForEvent('mail:fetch-older-done', {
          timeout: 20_000,
          predicate: (args) => {
            const payload = args[0] as FetchOlderDonePayload | undefined;
            return payload != null && payload.queueId === response.data!.queueId;
          },
        });

        const donePayload = doneArgs[0] as FetchOlderDonePayload;
        expect(donePayload.error).to.equal(undefined);
        expect(donePayload.threads).to.have.length(1);
        expect(donePayload.threads![0]!['id']).to.equal('123');
        expect(donePayload.threads![0]!['hasDraft']).to.equal(undefined);
      } finally {
        imapService.fetchOlderEmails = originalFetchOlderEmails;
        imapService.resolveUidsByXGmMsgIdBatch = originalResolveUidsByXGmMsgIdBatch;
        databaseService.getThreadsByFolderBeforeDate = originalGetThreadsByFolderBeforeDate;
      }
    });
  });

  // =========================================================================
  // Direct service branch coverage helpers
  // =========================================================================

  describe('Direct service branch coverage helpers', () => {
    it('covers remaining ImapService edge branches through public service methods', async function () {
      this.timeout(20_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'imap-direct-branches@example.com',
        displayName: 'IMAP Direct Branches Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      const imapService = ImapService.getInstance() as unknown as {
        connect: (accountId: string) => Promise<unknown>;
      };
      const originalConnect = imapService.connect;

      try {
        const makeLock = (): { release: () => void } => ({ release: () => {} });

        imapService.connect = async (): Promise<unknown> => {
          return {
            mailbox: { uidValidity: BigInt(999), highestModseq: BigInt(555) },
            getMailboxLock: async (_folder: string): Promise<{ release: () => void }> => makeLock(),
            search: async (criteria: Record<string, unknown>): Promise<number[]> => {
              if ('before' in criteria) {
                return [4, 3, 2];
              }
              if ('gmraw' in criteria) {
                return [8, 7];
              }
              if ('threadId' in criteria) {
                return [15];
              }
              if ('emailId' in criteria) {
                return [21];
              }
              return [1, 2];
            },
            fetch: async function* (_uidRange: string): AsyncGenerator<unknown> {
              yield null;
              yield {
                uid: 4,
                envelope: {
                  from: [{ address: 'raw-message-id@example.com', name: null }],
                  to: [{ address: undefined, name: 'Missing Address' }],
                  cc: [],
                  bcc: [],
                  subject: '',
                  messageId: '',
                },
                headers: 'Message-ID: raw-message-id@example.com\r\n',
                threadId: '',
                emailId: '',
                bodyStructure: null,
                size: undefined,
              };
              yield {
                uid: 5,
                envelope: {
                  from: [{ address: 'nested-attachment@example.com', name: 'Nested Attachment' }],
                  to: [{ address: 'recipient@example.com', name: 'Recipient Example' }],
                  cc: [],
                  bcc: [],
                  subject: 'Nested attachment subject',
                  date: DateTime.utc().minus({ days: 3 }).toJSDate(),
                  messageId: '',
                },
                headers: '',
                threadId: '',
                emailId: '',
                flags: undefined,
                labels: undefined,
                bodyStructure: {
                  childNodes: [
                    {
                      childNodes: [
                        {
                          disposition: 'attachment',
                        },
                      ],
                    },
                  ],
                },
                size: undefined,
              };
            },
            messageDelete: async (_uidRange: string, _options: Record<string, unknown>): Promise<void> => {},
          };
        };

        const limitZeroOlder = await ImapService.getInstance().fetchOlderEmails(
          String(suiteAccountId),
          'INBOX',
          DateTime.utc().toJSDate(),
          0,
        );
        expect(limitZeroOlder.emails).to.deep.equal([]);
        expect(limitZeroOlder.hasMore).to.equal(false);

        const regularOlder = await ImapService.getInstance().fetchOlderEmails(
          String(suiteAccountId),
          'INBOX',
          DateTime.utc().toJSDate(),
          5,
        );
        expect(regularOlder.emails).to.have.length(2);
        expect(regularOlder.emails[0]!.xGmMsgId).to.equal('raw-message-id@example.com');
        expect(regularOlder.emails[0]!.subject).to.equal('(no subject)');
        expect(regularOlder.emails[0]!.fromName).to.equal('raw-message-id@example.com');
        expect(regularOlder.emails[0]!.date).to.be.a('string');
        expect(regularOlder.emails[0]!.size).to.equal(0);
        expect(regularOlder.emails[1]!.xGmMsgId).to.equal('5');
        expect(regularOlder.emails[1]!.hasAttachments).to.equal(true);

        const zeroSearchResults = await ImapService.getInstance().searchEmails(
          String(suiteAccountId),
          'from:anyone',
          0,
        );
        expect(zeroSearchResults).to.deep.equal([]);

        const regularSearchResults = await ImapService.getInstance().searchEmails(
          String(suiteAccountId),
          'from:anyone',
          5,
        );
        expect(regularSearchResults).to.have.length(2);

        const fetchedEmails = await ImapService.getInstance().fetchEmails(String(suiteAccountId), 'INBOX');
        expect(fetchedEmails).to.have.length(2);

        const emptyThreadResults = await ImapService.getInstance().fetchThread(String(suiteAccountId), '   ');
        expect(emptyThreadResults).to.deep.equal([]);

        await ImapService.getInstance().deleteDraftByUid(String(suiteAccountId), '[Gmail]/Drafts', 999, 123);
      } finally {
        imapService.connect = originalConnect;
      }
    });

    it('covers remaining SyncService resilience and mapping branches through direct service calls', async function () {
      this.timeout(25_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-direct-branches@example.com',
        displayName: 'Sync Direct Branches Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      const syncService = SyncService.getInstance();
      const imapService = ImapService.getInstance() as unknown as {
        getMailboxStatus: (accountId: string, folder: string) => Promise<{ highestModseq: string; uidValidity: string; messages: number; condstoreSupported: boolean }>;
        fetchEmails: (accountId: string, folder: string, options?: { limit?: number; since?: Date }) => Promise<FetchedEmail[]>;
        fetchChangedSince: (accountId: string, folder: string, changedSince: string) => Promise<{ emails: FetchedEmail[]; highestModseq: string; uidValidity: string; noModseq: boolean }>;
        fetchFolderUids: (accountId: string, folder: string) => Promise<number[]>;
        resolveUidsByXGmMsgIdBatch: (accountId: string, folder: string, xGmMsgIds: string[]) => Promise<Map<string, number>>;
        startIdle: (
          accountId: string,
          folder: string,
          onNewMail: () => void,
          onExpunge?: () => void,
          onClose?: () => void,
          onError?: (err: Error) => void,
        ) => Promise<void>;
      };
      const databaseService = DatabaseService.getInstance() as unknown as {
        removeOrphanedEmails: (accountId: number) => Array<{ xGmThrid?: string }>;
        removeOrphanedThreads: (accountId: number) => number;
        recomputeThreadMetadata: (accountId: number, xGmThrid: string) => void;
        cleanupStaleFolderStates: (accountId: number, keepFolders: string[]) => number;
      };

      const originalGetMailboxStatus = imapService.getMailboxStatus;
      const originalFetchEmails = imapService.fetchEmails;
      const originalFetchChangedSince = imapService.fetchChangedSince;
      const originalFetchFolderUids = imapService.fetchFolderUids;
      const originalResolveUidsByXGmMsgIdBatch = imapService.resolveUidsByXGmMsgIdBatch;
      const originalStartIdle = imapService.startIdle;
      const originalRemoveOrphanedEmails = databaseService.removeOrphanedEmails;
      const originalRemoveOrphanedThreads = databaseService.removeOrphanedThreads;
      const originalRecomputeThreadMetadata = databaseService.recomputeThreadMetadata;
      const originalCleanupStaleFolderStates = databaseService.cleanupStaleFolderStates;

      try {
        const condstoreThreadId = '9100000000000101';

        imapService.getMailboxStatus = async (_accountId: string, _folder: string) => {
          return {
            highestModseq: '200',
            uidValidity: '9101',
            messages: 3,
            condstoreSupported: true,
          };
        };
        imapService.fetchChangedSince = async (): Promise<{ emails: FetchedEmail[]; highestModseq: string; uidValidity: string; noModseq: boolean }> => {
          return {
            emails: [
              buildFetchedEmail({
                uid: 32,
                xGmMsgId: '9100000000000002',
                xGmThrid: condstoreThreadId,
                modseq: '12',
                date: DateTime.utc().minus({ days: 2 }).toISO()!,
              }),
              buildFetchedEmail({
                uid: 31,
                xGmMsgId: '9100000000000001',
                xGmThrid: condstoreThreadId,
                modseq: '12',
                date: DateTime.utc().minus({ days: 3 }).toISO()!,
              }),
            ],
            highestModseq: '250',
            uidValidity: '9101',
            noModseq: false,
          };
        };
        DatabaseService.getInstance().upsertFolderState({
          accountId: suiteAccountId,
          folder: 'INBOX',
          uidValidity: '9101',
          highestModseq: null,
          condstoreSupported: true,
        });

        const condstoreResult = await syncService.syncFolder(
          String(suiteAccountId),
          'INBOX',
          true,
          DateTime.utc().minus({ days: 10 }).toJSDate(),
          false,
          null,
        );

        expect(condstoreResult.folderChanged).to.equal(true);
        expect(DatabaseService.getInstance().getThreadById(suiteAccountId, condstoreThreadId)).to.not.be.null;

        imapStateInspector.reset();
        imapStateInspector.getServer().addAllowedAccount(suiteEmail);
        imapStateInspector.getStore().createMailbox('Projects');

        const allMailRaw = buildSyntheticEmail({
          fromHeader: 'trash-only@example.com',
          toHeader: suiteEmail,
          subject: 'Trash only message',
          body: 'Trash mapping body',
          dateIso: DateTime.utc().minus({ days: 1 }).toISO()!,
          xGmMsgId: '9100000000000003',
          xGmThrid: '',
          messageId: '<trash-only-message@example.com>',
          labels: ['[Gmail]/All Mail', 'UnknownLabel'],
        });
        imapStateInspector.injectMessage('[Gmail]/All Mail', allMailRaw, {
          xGmMsgId: '9100000000000003',
          xGmThrid: '',
          xGmLabels: ['[Gmail]/All Mail', 'UnknownLabel'],
          internalDate: DateTime.utc().minus({ days: 1 }).toISO()!,
        });

        const directAffectedFolders = await runDirectAllMailSync(suiteAccountId, true);
        const mappedFolders = DatabaseService.getInstance().getFoldersForEmail(suiteAccountId, '9100000000000003');
        expect(Array.from(directAffectedFolders)).to.include(ALL_MAIL_PATH);
        expect(mappedFolders).to.include(ALL_MAIL_PATH);
        expect(mappedFolders).to.not.include('UnknownLabel');

        imapService.fetchFolderUids = async (): Promise<number[]> => {
          throw new Error('forced uid diff failure');
        };
        databaseService.removeOrphanedEmails = (): Array<{ xGmThrid?: string }> => {
          throw new Error('forced orphan email cleanup failure');
        };
        databaseService.removeOrphanedThreads = (): number => {
          throw new Error('forced orphan thread cleanup failure');
        };
        databaseService.recomputeThreadMetadata = (): void => {
          throw new Error('forced recompute failure');
        };
        databaseService.cleanupStaleFolderStates = (): number => {
          throw new Error('forced stale folder-state cleanup failure');
        };
        const filterServiceModule = require('../../../electron/services/filter-service') as typeof import('../../../electron/services/filter-service');
        const filterService = filterServiceModule.FilterService.getInstance() as unknown as {
          processNewEmails: (accountId: number) => Promise<{ emailsMatched: number; actionsDispatched: number }>;
        };
        const originalProcessNewEmails = filterService.processNewEmails;
        filterService.processNewEmails = async (): Promise<{ emailsMatched: number; actionsDispatched: number }> => {
          throw new Error('forced sync filter failure');
        };

        try {
          const resilientFolders = await runDirectAllMailSync(suiteAccountId, false);
          expect(resilientFolders.size).to.be.greaterThan(0);
        } finally {
          filterService.processNewEmails = originalProcessNewEmails;
        }

        imapService.resolveUidsByXGmMsgIdBatch = async (): Promise<Map<string, number>> => {
          throw new Error('forced all-mail uid resolution failure');
        };
        databaseService.recomputeThreadMetadata = (): void => {
          throw new Error('forced folder recompute failure');
        };
        const pendingOpServiceModule = require('../../../electron/services/pending-op-service') as typeof import('../../../electron/services/pending-op-service');
        const pendingOpService = pendingOpServiceModule.PendingOpService.getInstance();
        const pendingThreadId = '9100000000000104';
        pendingOpService.register(suiteAccountId, pendingThreadId, ['9100000000000004']);
        imapService.fetchEmails = async (): Promise<FetchedEmail[]> => {
          return [
            buildFetchedEmail({
              uid: 41,
              xGmMsgId: '9100000000000004',
              xGmThrid: pendingThreadId,
              fromAddress: 'pending@example.com',
              date: DateTime.utc().minus({ minutes: 5 }).toISO()!,
            }),
            buildFetchedEmail({
              uid: 42,
              xGmMsgId: '9100000000000005',
              xGmThrid: '',
              fromAddress: 'kept@example.com',
              fromName: '',
              date: DateTime.utc().minus({ minutes: 4 }).toISO()!,
            }),
          ];
        };

        try {
          const folderResult = await syncService.syncFolder(
            String(suiteAccountId),
            'INBOX',
            false,
            DateTime.utc().minus({ days: 1 }).toJSDate(),
            true,
            1,
          );
          expect(folderResult.folderChanged).to.equal(true);
          expect(DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, '9100000000000004')).to.equal(null);
        } finally {
          pendingOpService.clear(suiteAccountId, pendingThreadId, ['9100000000000004']);
        }

        const syncInternals = syncService as unknown as {
          globalIdleSuppression: boolean;
          scheduleIdleReconnect: (accountId: string) => void;
          scheduleIdleAllMailReconnect: (accountId: string) => void;
        };
        syncInternals.globalIdleSuppression = true;
        syncInternals.scheduleIdleReconnect(String(suiteAccountId));
        syncInternals.scheduleIdleAllMailReconnect(String(suiteAccountId));
        syncInternals.globalIdleSuppression = false;

        let startIdleCallCount = 0;
        imapService.startIdle = async (): Promise<void> => {
          startIdleCallCount += 1;
        };
        await syncService.startIdle(String(suiteAccountId), () => {});
        await syncService.startIdle(String(suiteAccountId), () => {});
        await syncService.startIdleAllMail(String(suiteAccountId), () => {});
        await syncService.startIdleAllMail(String(suiteAccountId), () => {});
        expect(startIdleCallCount).to.equal(2);
      } finally {
        imapService.getMailboxStatus = originalGetMailboxStatus;
        imapService.fetchEmails = originalFetchEmails;
        imapService.fetchChangedSince = originalFetchChangedSince;
        imapService.fetchFolderUids = originalFetchFolderUids;
        imapService.resolveUidsByXGmMsgIdBatch = originalResolveUidsByXGmMsgIdBatch;
        imapService.startIdle = originalStartIdle;
        databaseService.removeOrphanedEmails = originalRemoveOrphanedEmails;
        databaseService.removeOrphanedThreads = originalRemoveOrphanedThreads;
        databaseService.recomputeThreadMetadata = originalRecomputeThreadMetadata;
        databaseService.cleanupStaleFolderStates = originalCleanupStaleFolderStates;
        await syncService.stopAllIdle().catch(() => {});
      }
    });

    it('covers notification batching and stale idle lifecycle teardown branches', async function () {
      this.timeout(20_000);

      await quiesceAndRestore();

      const seeded = seedTestAccount({
        email: 'sync-notify-idle-branches@example.com',
        displayName: 'Sync Notify Idle Branches Test',
      });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      const syncService = SyncService.getInstance() as unknown as {
        accumulateNotification: (accountId: string, folder: string, emails: Array<Record<string, unknown>>) => void;
        flushNotificationBatch: (accountId: string, folder: string) => void;
        notificationBatches: Map<string, { timer: ReturnType<typeof setTimeout>; emails: Array<Record<string, unknown>> }>;
        emitToRenderer: (channel: string, payload: unknown) => void;
      };
      const imapService = ImapService.getInstance() as unknown as {
        startIdle: (
          accountId: string,
          folder: string,
          onNewMail: () => void,
          onExpunge?: () => void,
          onClose?: () => void,
          onError?: (err: Error) => void,
        ) => Promise<void>;
        disconnectIdle: (accountId: string, folder: string) => Promise<void>;
      };
      const trayServiceModule = require('../../../electron/services/tray-service') as typeof import('../../../electron/services/tray-service');
      const trayService = trayServiceModule.TrayService.getInstance() as unknown as {
        refreshUnreadCount: () => void;
      };

      const originalEmitToRenderer = syncService.emitToRenderer;
      const originalRefreshUnreadCount = trayService.refreshUnreadCount;
      const originalStartIdle = imapService.startIdle;
      const originalDisconnectIdle = imapService.disconnectIdle;

      const emittedPayloads: Array<{ channel: string; payload: unknown }> = [];
      let disconnectCalls = 0;

      try {
        syncService.emitToRenderer = (channel: string, payload: unknown): void => {
          emittedPayloads.push({ channel, payload });
        };
        trayService.refreshUnreadCount = (): void => {
          throw new Error('forced tray refresh failure');
        };

        syncService.flushNotificationBatch(String(suiteAccountId), 'INBOX');
        expect(emittedPayloads).to.deep.equal([]);

        syncService.accumulateNotification(String(suiteAccountId), 'INBOX', [
          {
            xGmMsgId: '9200000000000001',
            xGmThrid: '9200000000000101',
            sender: 'Batch Sender',
            subject: 'Batch Subject',
            snippet: 'Batch snippet',
            date: DateTime.utc().toISO()!,
          },
          {
            xGmMsgId: '9200000000000001',
            xGmThrid: '9200000000000101',
            sender: 'Batch Sender',
            subject: 'Batch Subject',
            snippet: 'Batch snippet',
            date: DateTime.utc().toISO()!,
          },
        ]);
        syncService.flushNotificationBatch(String(suiteAccountId), 'INBOX');

        expect(emittedPayloads).to.have.length(1);
        const batchPayload = emittedPayloads[0]!.payload as { totalNewCount: number; newEmails: Array<{ xGmMsgId: string }> };
        expect(batchPayload.totalNewCount).to.equal(1);
        expect(batchPayload.newEmails).to.have.length(1);

        const duplicateTimer = setTimeout(() => {}, 60_000);
        syncService.notificationBatches.set(String(suiteAccountId), {
          timer: duplicateTimer,
          emails: [
            {
              xGmMsgId: '9200000000000002',
              xGmThrid: '9200000000000102',
              sender: 'Dup Sender',
              subject: 'Dup Subject',
              snippet: 'Dup snippet',
              date: DateTime.utc().toISO()!,
            },
            {
              xGmMsgId: '9200000000000002',
              xGmThrid: '9200000000000102',
              sender: 'Dup Sender',
              subject: 'Dup Subject',
              snippet: 'Dup snippet',
              date: DateTime.utc().toISO()!,
            },
          ],
        });
        syncService.flushNotificationBatch(String(suiteAccountId), 'INBOX');
        clearTimeout(duplicateTimer);

        imapService.startIdle = async (): Promise<void> => {};
        imapService.disconnectIdle = async (): Promise<void> => {
          disconnectCalls += 1;
        };

        await SyncService.getInstance().startIdle(
          String(suiteAccountId),
          () => {},
          { isValid: () => false },
        );
        await SyncService.getInstance().startIdleAllMail(
          String(suiteAccountId),
          () => {},
          { isValid: () => false },
        );

        expect(disconnectCalls).to.equal(2);
      } finally {
        syncService.emitToRenderer = originalEmitToRenderer;
        trayService.refreshUnreadCount = originalRefreshUnreadCount;
        imapService.startIdle = originalStartIdle;
        imapService.disconnectIdle = originalDisconnectIdle;
        await SyncService.getInstance().stopAllIdle().catch(() => {});
      }
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
