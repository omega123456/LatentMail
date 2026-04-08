/**
 * attachments.test.ts — Backend E2E tests for attachment handling.
 *
 * Covers:
 *   - Attachment metadata listing via attachment:get-for-email
 *   - Binary content preview: cache miss → IMAP refetch → cache write-back
 *   - Binary content preview: cache hit (reads from disk, no IMAP call)
 *   - Text content preview: UTF-8 decoding
 *   - Download: stubs dialog.showSaveDialog to return a temp file path,
 *     verifies the file is written to that path
 *   - Attachment not found error path
 *   - Email not found error path
 *   - Draft attachment restoration from server draft MIME
 *   - Filename sanitization (path separators stripped)
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, dialog } from 'electron';
import { expect } from 'chai';
import { DateTime } from 'luxon';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  waitForEvent,
  seedTestAccount,
  triggerSyncAndWait,
  getDatabase,
  waitForQueueTerminalState,
} from '../infrastructure/test-helpers';
import { imapStateInspector } from '../test-main';
import { emlFixtures } from '../fixtures/index';
import { DatabaseService } from '../../../electron/services/database-service';
import { BodyPrefetchService } from '../../../electron/services/body-prefetch-service';

// ---- Type helpers ----

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface AttachmentMetadata {
  id: number;
  emailId: number;
  filename: string;
  mimeType: string | null;
  size: number | null;
  contentId: string | null;
  localPath: string | null;
}

interface OrphanEmailRecord {
  emailId: number;
  attachmentId: number;
  xGmMsgId: string;
}

interface CreateOrphanEmailOptions {
  suffix: string;
  subject: string;
  filename: string;
  mimeType: string | null;
  size: number;
}

interface CreateDraftAndGetMsgIdOptions {
  subject: string;
  to: string;
  textBody: string;
  description: string;
  attachments?: Array<{
    filename: string;
    mimeType: string;
    data: string;
  }>;
}

// ---- Suite-level state ----

let suiteAccountId: number;
let suiteEmail: string;

// -------------------------------------------------------------------------
// Helper: seed account + inject multipart message + sync
// -------------------------------------------------------------------------

async function setupWithAttachmentMessage(
  email: string,
  displayName: string,
): Promise<void> {
  await quiesceAndRestore();

  const seeded = seedTestAccount({ email, displayName });
  suiteAccountId = seeded.accountId;
  suiteEmail = seeded.email;

  imapStateInspector.reset();
  imapStateInspector.getServer().addAllowedAccount(suiteEmail);

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

  await triggerSyncAndWait(seeded.accountId, { timeout: 25_000 });

  // Body prefetch: attachment metadata is only stored after the message source
  // is fetched with `source: true`. The initial syncAllMail uses `source: false`
  // (header-only fetch) and does not populate the `attachments` table.
  // Call fetchAndStoreBodies() directly so attachment rows are present before tests run.
  const db = DatabaseService.getInstance();
  const emailsNeedingBodies = db.getEmailsNeedingBodies(seeded.accountId, 10);
  if (emailsNeedingBodies.length > 0) {
    try {
      await BodyPrefetchService.getInstance().fetchAndStoreBodies(
        seeded.accountId,
        emailsNeedingBodies,
      );
    } catch (prefetchError) {
      // Non-fatal: if prefetch fails, some attachment tests will fail too,
      // but the failure message will be more informative than a silent skip.
      console.warn('[setupWithAttachmentMessage] Body prefetch failed (non-fatal):', prefetchError);
    }
  }
}

function createOrphanEmail(
  db: DatabaseService,
  accountId: number,
  options: CreateOrphanEmailOptions,
): OrphanEmailRecord {
  const rawDb = db.getDatabase();
  const nowIso = DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z';
  const xGmThrid = `orphan-${options.suffix}-thread`;
  const xGmMsgId = `orphan-${options.suffix}-msg`;

  rawDb.prepare(
    `INSERT INTO threads (account_id, x_gm_thrid, subject, last_message_date, participants, message_count, snippet, is_read, is_starred)
     VALUES (:accountId, :xGmThrid, :subject, :lastMessageDate, :participants, :messageCount, :snippet, :isRead, :isStarred)`
  ).run({
    accountId,
    xGmThrid,
    subject: options.subject,
    lastMessageDate: nowIso,
    participants: 'Orphan Sender <orphan@example.com>',
    messageCount: 1,
    snippet: `orphan ${options.suffix} snippet`,
    isRead: 1,
    isStarred: 0,
  });

  const emailInsert = rawDb.prepare(
    `INSERT INTO emails (
       account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
       to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, date,
       is_read, is_starred, is_important, is_draft, snippet, size, has_attachments, labels
     ) VALUES (
       :accountId, :xGmMsgId, :xGmThrid, :messageId, :fromAddress, :fromName,
       :toAddresses, :ccAddresses, :bccAddresses, :subject, :textBody, :htmlBody, :date,
       :isRead, :isStarred, :isImportant, :isDraft, :snippet, :size, :hasAttachments, :labels
     )`
  ).run({
    accountId,
    xGmMsgId,
    xGmThrid,
    messageId: `<${xGmMsgId}@example.com>`,
    fromAddress: 'orphan@example.com',
    fromName: 'Orphan Sender',
    toAddresses: 'recipient@example.com',
    ccAddresses: '',
    bccAddresses: '',
    subject: options.subject,
    textBody: 'Body exists but no email_folders rows exist.',
    htmlBody: null,
    date: nowIso,
    isRead: 1,
    isStarred: 0,
    isImportant: 0,
    isDraft: 0,
    snippet: `orphan ${options.suffix} snippet`,
    size: 128,
    hasAttachments: 1,
    labels: '',
  });

  const emailId = Number(emailInsert.lastInsertRowid);
  const attachmentInsert = rawDb.prepare(
    `INSERT INTO attachments (email_id, filename, mime_type, size, content_id, local_path)
     VALUES (:emailId, :filename, :mimeType, :size, :contentId, :localPath)`
  ).run({
    emailId,
    filename: options.filename,
    mimeType: options.mimeType,
    size: options.size,
    contentId: null,
    localPath: null,
  });

  return {
    emailId,
    attachmentId: Number(attachmentInsert.lastInsertRowid),
    xGmMsgId,
  };
}

async function createDraftAndGetMsgId(
  accountId: number,
  options: CreateDraftAndGetMsgIdOptions,
): Promise<string> {
  const createDraftResponse = await callIpc('queue:enqueue', {
    type: 'draft-create',
    accountId,
    payload: {
      subject: options.subject,
      to: options.to,
      textBody: options.textBody,
      attachments: options.attachments,
    },
    description: options.description,
  }) as IpcResponse<{ queueId: string }>;

  expect(createDraftResponse.success).to.equal(true);
  const queueId = createDraftResponse.data!.queueId;
  await waitForQueueTerminalState(queueId, { expectedStatus: 'completed', timeout: 25_000 });

  const queueServiceModule = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
  const serverIds = queueServiceModule.MailQueueService.getInstance().getServerIds(queueId);
  expect(serverIds).to.not.equal(undefined);

  return serverIds!.xGmMsgId;
}

// =========================================================================
// Attachment metadata
// =========================================================================

describe('Attachments', () => {
  after(async function () {
    this.timeout(20_000);

    try {
      const bodyFetchQueueModule = require('../../../electron/services/body-fetch-queue-service') as typeof import('../../../electron/services/body-fetch-queue-service');
      await bodyFetchQueueModule.BodyFetchQueueService.getInstance().disconnectAll();
    } catch {
      // Best effort only for test-process shutdown stability.
    }

    try {
      const syncServiceModule = require('../../../electron/services/sync-service') as typeof import('../../../electron/services/sync-service');
      await syncServiceModule.SyncService.getInstance().stopAllIdle();
    } catch {
      // Best effort only for test-process shutdown stability.
    }

    try {
      const imapServiceModule = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
      await imapServiceModule.ImapService.getInstance().disconnectAllAndClearPending();
    } catch {
      // Best effort only for test-process shutdown stability.
    }
  });

  describe('attachment:get-for-email — metadata listing', () => {
    before(async function () {
      this.timeout(35_000);
      await setupWithAttachmentMessage('attachment-meta@example.com', 'Attachment Meta Test');
    });

    it('returns attachments for a message that has them', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      const response = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');

      // multipart-attachment.eml has notes.txt and small.png
      const filenames = response.data!.map((attachment) => attachment.filename);
      expect(filenames).to.include('notes.txt');
      expect(filenames).to.include('small.png');
    });

    it('returns an empty array for a message with no attachments', async () => {
      const plainHeaders = emlFixtures['plain-text'].headers;

      // The plain-text message was not synced in this suite, but we can inject it
      imapStateInspector.injectMessage('[Gmail]/All Mail', emlFixtures['plain-text'].raw, {
        xGmMsgId: plainHeaders.xGmMsgId,
        xGmThrid: plainHeaders.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', emlFixtures['plain-text'].raw, {
        xGmMsgId: plainHeaders.xGmMsgId,
        xGmThrid: plainHeaders.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });
      await triggerSyncAndWait(suiteAccountId, { timeout: 15_000 });

      const response = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        plainHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');
      expect(response.data!.length).to.equal(0);
    });

    it('returns INVALID_PARAMS for a missing xGmMsgId', async () => {
      const response = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        '',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('INVALID_PARAMS');
    });

    it('returns INVALID_ACCOUNT for a non-numeric accountId', async () => {
      const response = await callIpc(
        'attachment:get-for-email',
        'not-a-number',
        '12345',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('INVALID_ACCOUNT');
    });

    it('returns ATTACHMENT_FETCH_FAILED when attachment metadata lookup throws unexpectedly', async () => {
      const databaseService = DatabaseService.getInstance();
      const originalGetAttachmentsForEmail = databaseService.getAttachmentsForEmail.bind(databaseService);
      databaseService.getAttachmentsForEmail = (() => {
        throw new Error('forced metadata lookup failure');
      }) as typeof databaseService.getAttachmentsForEmail;

      try {
        const response = await callIpc(
          'attachment:get-for-email',
          String(suiteAccountId),
          emlFixtures['multipart-attachment'].headers.xGmMsgId,
        ) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_FETCH_FAILED');
      } finally {
        databaseService.getAttachmentsForEmail = originalGetAttachmentsForEmail;
      }
    });
  });

  // =========================================================================
  // Content preview — cache miss → IMAP fetch → cache write
  // =========================================================================

  describe('attachment:get-content — IMAP fetch on cache miss', () => {
    before(async function () {
      this.timeout(35_000);
      await setupWithAttachmentMessage('attachment-content@example.com', 'Attachment Content Test');
    });

    it('fetches attachment content from IMAP when not cached', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      // Get the attachment ID for notes.txt
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      // notes.txt should not be cached yet (fresh suite)
      expect(notesAttachment!.localPath).to.be.null;

      // Request the content — triggers IMAP fetch
      const contentResponse = await callIpc(
        'attachment:get-content',
        notesAttachment!.id,
      ) as IpcResponse<{ filename: string; mimeType: string; size: number; content: string }>;

      expect(contentResponse.success).to.equal(true);
      expect(contentResponse.data!.filename).to.equal('notes.txt');
      expect(contentResponse.data!.content).to.be.a('string');
      expect(contentResponse.data!.content.length).to.be.above(0);
    });

    it('attachment content is cached to disk after IMAP fetch', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      // Get the attachment metadata to find the ID
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const pngAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'small.png');
      expect(pngAttachment).to.not.be.undefined;

      // Fetch the content (may be cached from a previous call, either way is fine)
      const contentResponse = await callIpc(
        'attachment:get-content',
        pngAttachment!.id,
      ) as IpcResponse<{ filename: string; content: string }>;

      expect(contentResponse.success).to.equal(true);

      // Verify local_path is now set in the DB
      const db = DatabaseService.getInstance();
      const updatedAttachment = db.getAttachmentById(pngAttachment!.id);
      expect(updatedAttachment).to.not.be.null;
      expect(updatedAttachment!.localPath, 'attachment cache path should be persisted after fetch').to.be.a('string');
      expect(fs.existsSync(updatedAttachment!.localPath!)).to.equal(true);
      expect(fs.readFileSync(updatedAttachment!.localPath!).toString('base64')).to.equal(contentResponse.data!.content);
    });

    it('second request returns cached content without IMAP call', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      // Ensure content is cached first
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      // First call populates cache
      const firstResponse = await callIpc(
        'attachment:get-content',
        notesAttachment!.id,
      ) as IpcResponse<{ filename: string; content: string }>;

      expect(firstResponse.success).to.equal(true);

      // Verify the cache file exists
      const db = DatabaseService.getInstance();
      const cachedAttachmentRecord = db.getAttachmentById(notesAttachment!.id);

      expect(cachedAttachmentRecord).to.not.be.null;
      expect(cachedAttachmentRecord!.localPath, 'attachment cache path must exist before cache-hit assertion').to.be.a('string');
      expect(fs.existsSync(cachedAttachmentRecord!.localPath!)).to.equal(true);

      imapStateInspector.injectCommandError('FETCH', 'cache-hit test should not refetch from IMAP');

      try {
        // Second request should read from cache file
        const secondResponse = await callIpc(
          'attachment:get-content',
          notesAttachment!.id,
        ) as IpcResponse<{ filename: string; content: string }>;

        expect(secondResponse.success).to.equal(true);
        expect(secondResponse.data!.filename).to.equal('notes.txt');
        expect(secondResponse.data!.content).to.equal(firstResponse.data!.content);
      } finally {
        imapStateInspector.clearCommandErrors();
      }
    });

    it('returns ATTACHMENT_NOT_FOUND for a non-existent attachment ID', async () => {
      const response = await callIpc(
        'attachment:get-content',
        999999,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('ATTACHMENT_NOT_FOUND');
    });

    it('returns ATTACHMENT_EMAIL_NOT_FOUND when attachment metadata exists without a matching email', async () => {
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      let orphanAttachmentId: number | null = null;

      rawDb.pragma('foreign_keys = OFF');
      try {
        const insertResult = rawDb.prepare(
          `INSERT INTO attachments (email_id, filename, mime_type, size, content_id, local_path)
           VALUES (:emailId, :filename, :mimeType, :size, :contentId, :localPath)`
        ).run({
          emailId: 999999,
          filename: 'orphan.txt',
          mimeType: 'text/plain',
          size: 12,
          contentId: null,
          localPath: null,
        });
        orphanAttachmentId = Number(insertResult.lastInsertRowid);
      } finally {
        rawDb.pragma('foreign_keys = ON');
      }

      try {
        const response = await callIpc(
          'attachment:get-content',
          orphanAttachmentId,
        ) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_EMAIL_NOT_FOUND');
      } finally {
        if (orphanAttachmentId !== null) {
          rawDb.prepare('DELETE FROM attachments WHERE id = :id').run({ id: orphanAttachmentId });
        }
      }
    });

    it('returns ATTACHMENT_CONTENT_NOT_FOUND when the attachment email has no resolvable folder UIDs', async () => {
      const db = getDatabase();
      const orphanRecord = createOrphanEmail(db, suiteAccountId, {
        suffix: 'attachment',
        subject: 'Orphan attachment subject',
        filename: 'unreachable.txt',
        mimeType: 'text/plain',
        size: 20,
      });
      const response = await callIpc('attachment:get-content', orphanRecord.attachmentId) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('ATTACHMENT_CONTENT_NOT_FOUND');
    });

    it('returns ATTACHMENT_CONTENT_FAILED when IMAP FETCH throws while loading attachment content', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      const existingAttachment = DatabaseService.getInstance().getAttachmentById(notesAttachment!.id);
      if (existingAttachment?.localPath && fs.existsSync(existingAttachment.localPath)) {
        fs.unlinkSync(existingAttachment.localPath);
      }
      DatabaseService.getInstance().getDatabase().prepare(
        'UPDATE attachments SET local_path = NULL WHERE id = :id'
      ).run({ id: notesAttachment!.id });

      imapStateInspector.injectCommandError('FETCH', 'forced attachment content fetch failure');

      try {
        const response = await callIpc('attachment:get-content', notesAttachment!.id) as IpcResponse<unknown>;
        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_CONTENT_FAILED');
      } finally {
        imapStateInspector.clearCommandErrors();
      }
    });

    it('fetches CID-based inline attachment content by matching contentId', async function () {
      this.timeout(30_000);

      const inlineHeaders = emlFixtures['inline-images'].headers;
      imapStateInspector.injectMessage('[Gmail]/All Mail', emlFixtures['inline-images'].raw, {
        xGmMsgId: inlineHeaders.xGmMsgId,
        xGmThrid: inlineHeaders.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', emlFixtures['inline-images'].raw, {
        xGmMsgId: inlineHeaders.xGmMsgId,
        xGmThrid: inlineHeaders.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });

      const databaseService = DatabaseService.getInstance();
      const emailsNeedingBodies = databaseService.getEmailsNeedingBodies(suiteAccountId, 20);
      if (emailsNeedingBodies.length > 0) {
        await BodyPrefetchService.getInstance().fetchAndStoreBodies(suiteAccountId, emailsNeedingBodies);
      }

      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        inlineHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      expect(metaResponse.data).to.be.an('array');
      expect(metaResponse.data!.length).to.equal(0);

      const inlineEmail = databaseService.getEmailByXGmMsgId(suiteAccountId, inlineHeaders.xGmMsgId);
      expect(inlineEmail).to.not.be.null;

      const rawDb = databaseService.getDatabase();
      const insertResult = rawDb.prepare(
        `INSERT INTO attachments (email_id, filename, mime_type, size, content_id, local_path)
         VALUES (:emailId, :filename, :mimeType, :size, :contentId, :localPath)`
      ).run({
        emailId: Number(inlineEmail!['id']),
        filename: 'inline-logo.png',
        mimeType: 'image/png',
        size: 70,
        contentId: 'logo@example.com',
        localPath: null,
      });

      const inlineAttachmentId = Number(insertResult.lastInsertRowid);
      const insertedMetaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        inlineHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(insertedMetaResponse.success).to.equal(true);
      expect(insertedMetaResponse.data).to.be.an('array');
      expect(insertedMetaResponse.data!.length).to.equal(1);

      const inlineAttachment = insertedMetaResponse.data![0];
      expect(inlineAttachment.id).to.equal(inlineAttachmentId);
      expect(inlineAttachment.contentId).to.equal('logo@example.com');

      const contentResponse = await callIpc(
        'attachment:get-content',
        inlineAttachment.id,
      ) as IpcResponse<{ filename: string; mimeType: string; content: string }>;

      expect(contentResponse.success).to.equal(true);
      expect(contentResponse.data!.filename).to.equal('inline-logo.png');
      expect(contentResponse.data!.mimeType).to.equal('image/png');
      expect(contentResponse.data!.content.length).to.be.greaterThan(0);
    });

    it('returns ATTACHMENT_CONTENT_NOT_FOUND when attachment metadata does not match parsed message attachments', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const emailRecord = DatabaseService.getInstance().getEmailByXGmMsgId(suiteAccountId, multipartHeaders.xGmMsgId);
      expect(emailRecord).to.not.be.null;

      const rawDb = DatabaseService.getInstance().getDatabase();
      const insertResult = rawDb.prepare(
        `INSERT INTO attachments (email_id, filename, mime_type, size, content_id, local_path)
         VALUES (:emailId, :filename, :mimeType, :size, :contentId, :localPath)`
      ).run({
        emailId: Number(emailRecord!['id']),
        filename: 'missing-from-message.bin',
        mimeType: 'application/octet-stream',
        size: 99,
        contentId: null,
        localPath: null,
      });

      const missingAttachmentId = Number(insertResult.lastInsertRowid);
      const response = await callIpc('attachment:get-content', missingAttachmentId) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('ATTACHMENT_CONTENT_NOT_FOUND');
    });

    it('returns ATTACHMENT_CONTENT_NOT_FOUND when IMAP fetch succeeds but returns no source body', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const pngAttachmentachment = metaResponse.data!.find((attachment) => attachment.filename === 'small.png');
      expect(pngAttachmentachment).to.not.be.undefined;

      const databaseService = DatabaseService.getInstance();
      const cachedAttachment = databaseService.getAttachmentById(pngAttachmentachment!.id);
      if (cachedAttachment?.localPath && fs.existsSync(cachedAttachment.localPath)) {
        fs.unlinkSync(cachedAttachment.localPath);
      }
      databaseService.getDatabase().prepare(
        'UPDATE attachments SET local_path = NULL WHERE id = :id'
      ).run({ id: pngAttachmentachment!.id });

      const imapServiceModule = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
      const imapService = imapServiceModule.ImapService.getInstance() as unknown as {
        connect: (accountId: string) => Promise<unknown>;
      };
      const originalConnect = imapService.connect;
      imapService.connect = (async () => {
        return {
          getMailboxLock: async () => ({
            release: (): void => {
              // no-op test lock
            },
          }),
          fetchOne: async (): Promise<Record<string, unknown>> => ({ source: null }),
        };
      }) as typeof imapService.connect;

      try {
        const response = await callIpc('attachment:get-content', pngAttachmentachment!.id) as IpcResponse<unknown>;
        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_CONTENT_NOT_FOUND');
      } finally {
        imapService.connect = originalConnect;
      }
    });

    it('returns application/octet-stream when cached attachment metadata has no mimeType', async () => {
      const databaseService = DatabaseService.getInstance();
      const emailRecord = databaseService.getEmailByXGmMsgId(
        suiteAccountId,
        emlFixtures['multipart-attachment'].headers.xGmMsgId,
      );
      expect(emailRecord).to.not.be.null;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-cache-hit-'));
      const tempFilePath = path.join(tempDir, 'cached-attachment.bin');
      fs.writeFileSync(tempFilePath, Buffer.from('cached binary data', 'utf8'));

      const insertResult = databaseService.getDatabase().prepare(
        `INSERT INTO attachments (email_id, filename, mime_type, size, content_id, local_path)
         VALUES (:emailId, :filename, :mimeType, :size, :contentId, :localPath)`
      ).run({
        emailId: Number(emailRecord!['id']),
        filename: 'cached-no-mime.bin',
        mimeType: null,
        size: 18,
        contentId: null,
        localPath: tempFilePath,
      });

      const attachmentId = Number(insertResult.lastInsertRowid);

      try {
        const response = await callIpc('attachment:get-content', attachmentId) as IpcResponse<{
          mimeType: string;
          content: string;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.mimeType).to.equal('application/octet-stream');
        expect(Buffer.from(response.data!.content, 'base64').toString('utf8')).to.equal('cached binary data');
      } finally {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
        if (fs.existsSync(tempDir)) {
          fs.rmdirSync(tempDir);
        }
      }
    });

    it('returns success when caching attachment content to disk fails after IMAP fetch', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      const databaseService = DatabaseService.getInstance();
      const cachedAttachment = databaseService.getAttachmentById(notesAttachment!.id);
      if (cachedAttachment?.localPath && fs.existsSync(cachedAttachment.localPath)) {
        fs.unlinkSync(cachedAttachment.localPath);
      }
      databaseService.getDatabase().prepare(
        'UPDATE attachments SET local_path = NULL WHERE id = :id'
      ).run({ id: notesAttachment!.id });

      const fsModule = require('fs') as typeof import('fs');
      const originalWriteFileSync = fsModule.writeFileSync;
      fsModule.writeFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: unknown) => {
        if (typeof filePath === 'string' && filePath.includes(`${path.sep}attachments${path.sep}`)) {
          throw new Error('forced attachment cache write failure');
        }
        return originalWriteFileSync(filePath, data, options as never);
      }) as typeof fs.writeFileSync;

      try {
        const response = await callIpc('attachment:get-content', notesAttachment!.id) as IpcResponse<{
          filename: string;
          content: string;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.filename).to.equal('notes.txt');
        expect(response.data!.content.length).to.be.greaterThan(0);
      } finally {
        fsModule.writeFileSync = originalWriteFileSync;
      }
    });

    it('returns ATTACHMENT_CONTENT_FAILED with the fallback message when a non-Error value is thrown', async () => {
      const databaseService = DatabaseService.getInstance();
      const originalGetAttachmentById = databaseService.getAttachmentById.bind(databaseService);
      databaseService.getAttachmentById = (() => {
        throw 'non-error-attachment-content-failure';
      }) as typeof databaseService.getAttachmentById;

      try {
        const response = await callIpc('attachment:get-content', 1) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_CONTENT_FAILED');
        expect(response.error!.message).to.equal('Failed to get attachment content');
      } finally {
        databaseService.getAttachmentById = originalGetAttachmentById;
      }
    });

    it('falls back to IMAP fetch when reading a cached attachment file throws', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      await callIpc('attachment:get-content', notesAttachment!.id);

      const databaseService = DatabaseService.getInstance();
      const cachedAttachment = databaseService.getAttachmentById(notesAttachment!.id);
      expect(cachedAttachment).to.not.be.null;
      expect(cachedAttachment!.localPath).to.be.a('string');

      const fsModule = require('fs') as typeof import('fs');
      const originalReadFileSync = fsModule.readFileSync;
      const cachedPath = cachedAttachment!.localPath!;
      fsModule.readFileSync = ((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
        if (filePath === cachedPath) {
          throw new Error('forced cached attachment read failure');
        }
        return originalReadFileSync(filePath, options as never);
      }) as typeof fs.readFileSync;

      try {
        const response = await callIpc('attachment:get-content', notesAttachment!.id) as IpcResponse<{
          filename: string;
          content: string;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.filename).to.equal('notes.txt');
        expect(response.data!.content.length).to.be.greaterThan(0);
      } finally {
        fsModule.readFileSync = originalReadFileSync;
      }
    });
  });

  // =========================================================================
  // Content as text — UTF-8 decoding
  // =========================================================================

  describe('attachment:get-content-as-text — text decoding', () => {
    before(async function () {
      this.timeout(35_000);
      await setupWithAttachmentMessage('attachment-text@example.com', 'Attachment Text Test');
    });

    it('decodes text attachment as UTF-8 string', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      const textResponse = await callIpc(
        'attachment:get-content-as-text',
        notesAttachment!.id,
      ) as IpcResponse<{ filename: string; mimeType: string; text: string }>;

      expect(textResponse.success).to.equal(true);
      expect(textResponse.data!.text).to.be.a('string');
      expect(textResponse.data!.text.length).to.be.above(0);
      // The content of notes.txt is base64-encoded "Hello World! This is a test attachment."
      expect(textResponse.data!.text).to.include('Hello');
    });

    it('returns ATTACHMENT_NOT_FOUND for non-existent ID', async () => {
      const response = await callIpc(
        'attachment:get-content-as-text',
        999999,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('ATTACHMENT_NOT_FOUND');
    });

    it('returns a lossy text preview for binary attachments without failing', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const pngAttachmentachment = metaResponse.data!.find((attachment) => attachment.filename === 'small.png');
      expect(pngAttachmentachment).to.not.be.undefined;

      const textResponse = await callIpc(
        'attachment:get-content-as-text',
        pngAttachmentachment!.id,
      ) as IpcResponse<{ filename: string; mimeType: string; text: string }>;

      expect(textResponse.success).to.equal(true);
      expect(textResponse.data!.filename).to.equal('small.png');
      expect(textResponse.data!.mimeType).to.equal('image/png');
      expect(textResponse.data!.text).to.be.a('string');
      expect(textResponse.data!.text.length).to.be.greaterThan(0);
    });

    it('falls back to IMAP when reading cached text content throws', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      await callIpc('attachment:get-content', notesAttachment!.id);
      const cachedAttachment = DatabaseService.getInstance().getAttachmentById(notesAttachment!.id);
      expect(cachedAttachment).to.not.be.null;
      expect(cachedAttachment!.localPath).to.be.a('string');

      const fsModule = require('fs') as typeof import('fs');
      const originalReadFileSync = fsModule.readFileSync;
      const cachedPath = cachedAttachment!.localPath!;
      fsModule.readFileSync = ((filePath: fs.PathOrFileDescriptor, options?: unknown) => {
        if (filePath === cachedPath) {
          throw new Error('forced cached text read failure');
        }
        return originalReadFileSync(filePath, options as never);
      }) as typeof fs.readFileSync;

      try {
        const response = await callIpc('attachment:get-content-as-text', notesAttachment!.id) as IpcResponse<{
          filename: string;
          text: string;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.filename).to.equal('notes.txt');
        expect(response.data!.text).to.include('Hello');
      } finally {
        fsModule.readFileSync = originalReadFileSync;
      }
    });

    it('returns ATTACHMENT_EMAIL_NOT_FOUND when text content is requested for orphaned attachment metadata', async () => {
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      let orphanAttachmentId: number | null = null;

      rawDb.pragma('foreign_keys = OFF');
      try {
        const insertResult = rawDb.prepare(
          `INSERT INTO attachments (email_id, filename, mime_type, size, content_id, local_path)
           VALUES (:emailId, :filename, :mimeType, :size, :contentId, :localPath)`
        ).run({
          emailId: 999999,
          filename: 'orphan-text.txt',
          mimeType: 'text/plain',
          size: 10,
          contentId: null,
          localPath: null,
        });
        orphanAttachmentId = Number(insertResult.lastInsertRowid);
      } finally {
        rawDb.pragma('foreign_keys = ON');
      }

      try {
        const response = await callIpc('attachment:get-content-as-text', orphanAttachmentId) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_EMAIL_NOT_FOUND');
      } finally {
        if (orphanAttachmentId !== null) {
          rawDb.prepare('DELETE FROM attachments WHERE id = :id').run({ id: orphanAttachmentId });
        }
      }
    });

    it('returns ATTACHMENT_CONTENT_NOT_FOUND when text content is requested for an attachment with no resolvable folder UIDs', async () => {
      const db = getDatabase();
      const orphanRecord = createOrphanEmail(db, suiteAccountId, {
        suffix: 'text',
        subject: 'Orphan text subject',
        filename: 'unreachable-text.txt',
        mimeType: null,
        size: 20,
      });
      const response = await callIpc('attachment:get-content-as-text', orphanRecord.attachmentId) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('ATTACHMENT_CONTENT_NOT_FOUND');
    });

    it('returns application/octet-stream when text attachment metadata has no mimeType', async () => {
      const databaseService = DatabaseService.getInstance();
      const emailRecord = databaseService.getEmailByXGmMsgId(
        suiteAccountId,
        emlFixtures['multipart-attachment'].headers.xGmMsgId,
      );
      expect(emailRecord).to.not.be.null;

      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-text-cache-hit-'));
      const tempFilePath = path.join(tempDir, 'cached-text.txt');
      fs.writeFileSync(tempFilePath, Buffer.from('plain text cache', 'utf8'));

      const insertResult = databaseService.getDatabase().prepare(
        `INSERT INTO attachments (email_id, filename, mime_type, size, content_id, local_path)
         VALUES (:emailId, :filename, :mimeType, :size, :contentId, :localPath)`
      ).run({
        emailId: Number(emailRecord!['id']),
        filename: 'cached-no-mime-text.txt',
        mimeType: null,
        size: 16,
        contentId: null,
        localPath: tempFilePath,
      });

      const attachmentId = Number(insertResult.lastInsertRowid);

      try {
        const response = await callIpc('attachment:get-content-as-text', attachmentId) as IpcResponse<{
          mimeType: string;
          text: string;
        }>;

        expect(response.success).to.equal(true);
        expect(response.data!.mimeType).to.equal('application/octet-stream');
        expect(response.data!.text).to.equal('plain text cache');
      } finally {
        if (fs.existsSync(tempFilePath)) {
          fs.unlinkSync(tempFilePath);
        }
        if (fs.existsSync(tempDir)) {
          fs.rmdirSync(tempDir);
        }
      }
    });

    it('returns ATTACHMENT_CONTENT_FAILED for text content when a non-Error value is thrown', async () => {
      const databaseService = DatabaseService.getInstance();
      const originalGetAttachmentById = databaseService.getAttachmentById.bind(databaseService);
      databaseService.getAttachmentById = (() => {
        throw 'non-error-attachment-text-failure';
      }) as typeof databaseService.getAttachmentById;

      try {
        const response = await callIpc('attachment:get-content-as-text', 1) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_CONTENT_FAILED');
        expect(response.error!.message).to.equal('Failed to get attachment text');
      } finally {
        databaseService.getAttachmentById = originalGetAttachmentById;
      }
    });
  });

  // =========================================================================
  // Download — stubs dialog.showSaveDialog
  // =========================================================================

  describe('attachment:download — stub dialog.showSaveDialog', () => {
    let originalShowSaveDialog: typeof dialog.showSaveDialog;
    let tempDownloadPath: string;

    before(async function () {
      this.timeout(35_000);
      await setupWithAttachmentMessage('attachment-download@example.com', 'Attachment Download Test');

      // Create a temp file path for the download target
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-dl-test-'));
      tempDownloadPath = path.join(tempDir, 'downloaded-notes.txt');

      // Save original dialog method and stub it
      originalShowSaveDialog = dialog.showSaveDialog;
      (dialog as { showSaveDialog: unknown }).showSaveDialog = async () => ({
        canceled: false,
        filePath: tempDownloadPath,
      });
    });

    after(function () {
      // Restore the original dialog method
      (dialog as { showSaveDialog: unknown }).showSaveDialog = originalShowSaveDialog;

      // Clean up temp file if it exists
      if (fs.existsSync(tempDownloadPath)) {
        try {
          fs.unlinkSync(tempDownloadPath);
        } catch {
          // Non-fatal
        }
      }
    });

    it('writes the attachment content to the stubbed file path', async function () {
      this.timeout(25_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      // Get attachment metadata to find the ID
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      // Ensure the temp file does not exist yet
      if (fs.existsSync(tempDownloadPath)) {
        fs.unlinkSync(tempDownloadPath);
      }

      const downloadResponse = await callIpc(
        'attachment:download',
        notesAttachment!.id,
      ) as IpcResponse<{ saved: boolean; filePath?: string }>;

      expect(downloadResponse.success).to.equal(true);
      expect(downloadResponse.data!.saved).to.equal(true);
      expect(downloadResponse.data!.filePath).to.equal(tempDownloadPath);

      // Verify the file actually exists and has content
      expect(fs.existsSync(tempDownloadPath)).to.equal(true);
      const writtenContent = fs.readFileSync(tempDownloadPath);
      expect(writtenContent.length).to.be.above(0);
    });

    it('returns saved=false when dialog is canceled', async function () {
      this.timeout(25_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      // Override stub to simulate user cancellation
      (dialog as { showSaveDialog: unknown }).showSaveDialog = async () => ({
        canceled: true,
        filePath: undefined,
      });

      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
      expect(notesAttachment).to.not.be.undefined;

      const downloadResponse = await callIpc(
        'attachment:download',
        notesAttachment!.id,
      ) as IpcResponse<{ saved: boolean }>;

      expect(downloadResponse.success).to.equal(true);
      expect(downloadResponse.data!.saved).to.equal(false);

      // Restore the stub to the save-dialog path for subsequent tests
      (dialog as { showSaveDialog: unknown }).showSaveDialog = async () => ({
        canceled: false,
        filePath: tempDownloadPath,
      });
    });

    it('returns ATTACHMENT_NOT_FOUND for non-existent attachment ID', async () => {
      const response = await callIpc(
        'attachment:download',
        999999,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('ATTACHMENT_NOT_FOUND');
    });

    it('returns ATTACHMENT_DOWNLOAD_FAILED when the selected save path cannot be written', async function () {
      this.timeout(25_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const unwritableTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'attach-dl-fail-'));

      (dialog as { showSaveDialog: unknown }).showSaveDialog = async () => ({
        canceled: false,
        filePath: unwritableTarget,
      });

      try {
        const metaResponse = await callIpc(
          'attachment:get-for-email',
          String(suiteAccountId),
          multipartHeaders.xGmMsgId,
        ) as IpcResponse<AttachmentMetadata[]>;

        expect(metaResponse.success).to.equal(true);
        const notesAttachment = metaResponse.data!.find((attachment) => attachment.filename === 'notes.txt');
        expect(notesAttachment).to.not.be.undefined;

        const downloadResponse = await callIpc(
          'attachment:download',
          notesAttachment!.id,
        ) as IpcResponse<unknown>;

        expect(downloadResponse.success).to.equal(false);
        expect(downloadResponse.error!.code).to.equal('ATTACHMENT_DOWNLOAD_FAILED');
      } finally {
        (dialog as { showSaveDialog: unknown }).showSaveDialog = async () => ({
          canceled: false,
          filePath: tempDownloadPath,
        });

        if (fs.existsSync(unwritableTarget)) {
          fs.rmdirSync(unwritableTarget);
        }
      }
    });

    it('returns ATTACHMENT_EMAIL_NOT_FOUND when download metadata exists without a matching email', async () => {
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      let orphanAttachmentId: number | null = null;

      rawDb.pragma('foreign_keys = OFF');
      try {
        const insertResult = rawDb.prepare(
          `INSERT INTO attachments (email_id, filename, mime_type, size, content_id, local_path)
           VALUES (:emailId, :filename, :mimeType, :size, :contentId, :localPath)`
        ).run({
          emailId: 999999,
          filename: 'orphan-download.txt',
          mimeType: 'text/plain',
          size: 10,
          contentId: null,
          localPath: null,
        });
        orphanAttachmentId = Number(insertResult.lastInsertRowid);
      } finally {
        rawDb.pragma('foreign_keys = ON');
      }

      try {
        const response = await callIpc('attachment:download', orphanAttachmentId) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_EMAIL_NOT_FOUND');
      } finally {
        if (orphanAttachmentId !== null) {
          rawDb.prepare('DELETE FROM attachments WHERE id = :id').run({ id: orphanAttachmentId });
        }
      }
    });

    it('returns ATTACHMENT_CONTENT_NOT_FOUND when download cannot resolve attachment content from IMAP', async () => {
      const db = getDatabase();
      const orphanRecord = createOrphanEmail(db, suiteAccountId, {
        suffix: 'download',
        subject: 'Orphan download subject',
        filename: 'unreachable-download.txt',
        mimeType: 'text/plain',
        size: 20,
      });
      const response = await callIpc('attachment:download', orphanRecord.attachmentId) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('ATTACHMENT_CONTENT_NOT_FOUND');
    });
  });

  // =========================================================================
  // Draft attachment restoration
  // =========================================================================

  describe('attachment:fetch-draft-attachments — draft MIME parsing', () => {
    before(async function () {
      this.timeout(35_000);
      await setupWithAttachmentMessage('attachment-draft@example.com', 'Attachment Draft Test');
    });

    it('returns DRAFT_NOT_FOUND for a message not in Drafts folder', async function () {
      this.timeout(15_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;

      // multipart-attachment.eml is in INBOX, not Drafts — should fail
      const response = await callIpc(
        'attachment:fetch-draft-attachments',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<unknown>;

      // The message is not in [Gmail]/Drafts — should return DRAFT_NOT_FOUND
      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('DRAFT_NOT_FOUND');
    });

    it('returns INVALID_ACCOUNT for a non-numeric accountId', async () => {
      const response = await callIpc(
        'attachment:fetch-draft-attachments',
        'not-a-number',
        '1234567890',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('INVALID_ACCOUNT');
    });

    it('returns DRAFT_NOT_FOUND for a non-existent draft message ID', async () => {
      const response = await callIpc(
        'attachment:fetch-draft-attachments',
        String(suiteAccountId),
        'missing-draft-xgmmsgid',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('DRAFT_NOT_FOUND');
    });

    it('returns restored attachment objects for a real draft created with attachments', async function () {
      this.timeout(30_000);

      const draftXGmMsgId = await createDraftAndGetMsgId(suiteAccountId, {
        subject: 'Draft with attachment restore',
        to: 'draft-attachment-restore@example.com',
        textBody: 'Draft attachment restore body',
        description: 'Create draft with attachment for restoration',
        attachments: [
          {
            filename: 'restore.txt',
            mimeType: 'text/plain',
            data: Buffer.from('draft attachment contents', 'utf8').toString('base64'),
          },
        ],
      });

      const response = await callIpc(
        'attachment:fetch-draft-attachments',
        String(suiteAccountId),
        draftXGmMsgId,
      ) as IpcResponse<Array<{ filename: string; mimeType: string; size: number; data: string }>>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');
      expect(response.data!.length).to.equal(1);
      expect(response.data![0].filename).to.equal('restore.txt');
      expect(response.data![0].mimeType).to.equal('text/plain');
      expect(Buffer.from(response.data![0].data, 'base64').toString('utf8')).to.equal('draft attachment contents');
    });

    it('omits CID-only inline parts when restoring draft attachments', async function () {
      this.timeout(30_000);

      // Build a real multipart MIME message with BOTH an inline image (CID-only,
      // Content-Disposition: inline) and a regular file attachment (Content-Disposition: attachment).
      // The draft attachment restoration handler should filter out the CID-only inline part
      // and return only the regular file attachment.
      const inlineDraftXGmMsgId = '9990000000000099';
      const inlineDraftXGmThrid = '9990000000000099';

      const draftEml = Buffer.from([
        'From: draft-inline-restore@example.com',
        'To: draft-inline-restore-recipient@example.com',
        'Subject: Draft with filtered inline restore',
        'Date: Wed, 03 Jan 2024 12:00:00 +0000',
        `Message-ID: <draft-inline-restore-${DateTime.now().toMillis()}@example.com>`,
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="==draft_inline_boundary=="',
        `X-GM-MSGID: ${inlineDraftXGmMsgId}`,
        `X-GM-THRID: ${inlineDraftXGmThrid}`,
        '',
        '--==draft_inline_boundary==',
        'Content-Type: multipart/related; boundary="==draft_related_boundary=="',
        '',
        '--==draft_related_boundary==',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'Inline restore body',
        '',
        '--==draft_related_boundary==',
        'Content-Type: image/png',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: inline',
        'Content-ID: <inline-logo@example.com>',
        '',
        Buffer.from('abc', 'utf8').toString('base64'),
        '',
        '--==draft_related_boundary==--',
        '',
        '--==draft_inline_boundary==',
        'Content-Type: text/plain',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="visible.txt"',
        '',
        Buffer.from('visible draft attachment', 'utf8').toString('base64'),
        '',
        '--==draft_inline_boundary==--',
      ].join('\r\n'));

      // Inject directly into Drafts folder on the fake IMAP server
      imapStateInspector.injectMessage('[Gmail]/Drafts', draftEml, {
        xGmMsgId: inlineDraftXGmMsgId,
        xGmThrid: inlineDraftXGmThrid,
        xGmLabels: ['\\Draft'],
        flags: ['\\Draft', '\\Seen'],
      });

      // Register the message in the DB so the IPC handler can locate it
      const db = getDatabase();
      const rawDb = db.getDatabase();

      // Upsert the email record
      rawDb.prepare(`
        INSERT OR REPLACE INTO emails (account_id, x_gm_msgid, x_gm_thrid, message_id, from_address, from_name,
          to_addresses, cc_addresses, bcc_addresses, subject, text_body, html_body, date, is_read, is_starred,
          is_important, is_draft, snippet, size, has_attachments, labels)
        VALUES (:accountId, :xGmMsgId, :xGmThrid, :messageId, :fromAddress, :fromName,
          :toAddresses, :ccAddresses, :bccAddresses, :subject, :textBody, :htmlBody, :date, :isRead, :isStarred,
          :isImportant, :isDraft, :snippet, :size, :hasAttachments, :labels)
      `).run({
        accountId: suiteAccountId,
        xGmMsgId: inlineDraftXGmMsgId,
        xGmThrid: inlineDraftXGmThrid,
        messageId: '<draft-inline-restore@example.com>',
        fromAddress: 'draft-inline-restore@example.com',
        fromName: 'Draft Inline Restore',
        toAddresses: 'draft-inline-restore-recipient@example.com',
        ccAddresses: '',
        bccAddresses: '',
        subject: 'Draft with filtered inline restore',
        textBody: 'Inline restore body',
        htmlBody: '',
        date: '2024-01-03T12:00:00.000Z',
        isRead: 1,
        isStarred: 0,
        isImportant: 0,
        isDraft: 1,
        snippet: 'Draft with filtered inline restore',
        size: draftEml.length,
        hasAttachments: 1,
        labels: '\\Draft',
      });

      // Get the email ID
      const emailRow = rawDb.prepare(
        'SELECT id FROM emails WHERE x_gm_msgid = :xGmMsgId AND account_id = :accountId',
      ).get({ xGmMsgId: inlineDraftXGmMsgId, accountId: suiteAccountId }) as { id: number } | undefined;

      expect(emailRow).to.not.be.undefined;

      // Register in the email_folders junction table so getFolderUidsForEmail finds it
      const draftsMessages = imapStateInspector.getMessages('[Gmail]/Drafts');
      const injectedDraft = draftsMessages.find(
        (message) => message.xGmMsgId === inlineDraftXGmMsgId,
      );
      expect(injectedDraft).to.not.be.undefined;

      rawDb.prepare(`
        INSERT OR REPLACE INTO email_folders (account_id, x_gm_msgid, folder, uid)
        VALUES (:accountId, :xGmMsgId, :folder, :uid)
      `).run({
        accountId: suiteAccountId,
        xGmMsgId: inlineDraftXGmMsgId,
        folder: '[Gmail]/Drafts',
        uid: injectedDraft!.uid,
      });

      const response = await callIpc(
        'attachment:fetch-draft-attachments',
        String(suiteAccountId),
        inlineDraftXGmMsgId,
      ) as IpcResponse<Array<{ filename: string; mimeType: string; size: number; data: string }>>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');
      expect(response.data!.map((attachment) => attachment.filename)).to.include('visible.txt');
      expect(response.data!.map((attachment) => attachment.filename)).to.not.include('inline-logo.png');
    });

    it('returns ATTACHMENT_DRAFT_FETCH_FAILED when fetching the draft source throws', async function () {
      this.timeout(25_000);

      const draftXGmMsgId = await createDraftAndGetMsgId(suiteAccountId, {
        subject: 'Draft attachment fetch failure',
        to: 'draft-fetch-failure@example.com',
        textBody: 'Draft source fetch failure test',
        description: 'Create draft for attachment failure path',
      });

      imapStateInspector.injectCommandError('FETCH', 'forced draft fetch failure');

      try {
        const response = await callIpc(
          'attachment:fetch-draft-attachments',
          String(suiteAccountId),
          draftXGmMsgId,
        ) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_DRAFT_FETCH_FAILED');
      } finally {
        imapStateInspector.clearCommandErrors();
      }
    });
  });

  // =========================================================================
  // Content-ID on file attachments (Outlook / Apple Mail behaviour)
  // =========================================================================

  describe('attachment-with-content-id — file attachment with Content-ID header', () => {
    before(async function () {
      this.timeout(35_000);
      await quiesceAndRestore();

      const seeded = seedTestAccount({ email: 'attachment-cid-file@example.com', displayName: 'CID File Test' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      const cidAttachmentMsg = emlFixtures['attachment-with-content-id'];
      imapStateInspector.injectMessage('[Gmail]/All Mail', cidAttachmentMsg.raw, {
        xGmMsgId: cidAttachmentMsg.headers.xGmMsgId,
        xGmThrid: cidAttachmentMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', cidAttachmentMsg.raw, {
        xGmMsgId: cidAttachmentMsg.headers.xGmMsgId,
        xGmThrid: cidAttachmentMsg.headers.xGmThrid,
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(seeded.accountId, { timeout: 25_000 });

      // Trigger body prefetch so attachment metadata rows are persisted
      const db = DatabaseService.getInstance();
      const emailsNeedingBodies = db.getEmailsNeedingBodies(seeded.accountId, 10);
      if (emailsNeedingBodies.length > 0) {
        await BodyPrefetchService.getInstance().fetchAndStoreBodies(
          seeded.accountId,
          emailsNeedingBodies,
        );
      }
    });

    it('preserves file attachment metadata even when the attachment has a Content-ID header', async function () {
      this.timeout(20_000);

      const cidHeaders = emlFixtures['attachment-with-content-id'].headers;

      const response = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        cidHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');

      // The bug: attachment-with-content-id.eml has a file attachment (report.txt)
      // with Content-Disposition: attachment AND Content-ID. The attachment should
      // NOT be filtered out as an inline image.
      expect(response.data!.length).to.be.greaterThan(0, 'attachment with Content-ID + Content-Disposition: attachment must not be filtered out');

      const reportAttachment = response.data!.find((attachment) => attachment.filename === 'report.txt');
      expect(reportAttachment, 'report.txt should be present in attachment metadata').to.not.be.undefined;
      expect(reportAttachment!.mimeType).to.equal('text/plain');
    });
  });

  // =========================================================================
  // Filename sanitization
  // =========================================================================

  describe('Filename sanitization', () => {
    it('sanitizes filenames with path separators and special chars in download path', async function () {
      this.timeout(25_000);

      await quiesceAndRestore();
      const seeded = seedTestAccount({ email: 'attachment-sanitize@example.com' });
      suiteAccountId = seeded.accountId;
      suiteEmail = seeded.email;

      imapStateInspector.reset();
      imapStateInspector.getServer().addAllowedAccount(suiteEmail);

      // Inject a multipart message where one attachment has a dangerous filename
      // We need to create a custom EML with a path-traversal filename
      const dangerousFilenameEml = Buffer.from([
        'From: eve@example.com',
        'To: frank@example.com',
        'Subject: Dangerous filename test',
        'Date: Wed, 03 Jan 2024 12:00:00 +0000',
        'Message-ID: <dangerous-filename-001@example.com>',
        'MIME-Version: 1.0',
        'Content-Type: multipart/mixed; boundary="==test_boundary=="',
        'X-GM-MSGID: 7770000000000001',
        'X-GM-THRID: 7770000000000001',
        'X-GM-LABELS: \\Inbox',
        '',
        '--==test_boundary==',
        'Content-Type: text/plain; charset=UTF-8',
        '',
        'Hello',
        '',
        '--==test_boundary==',
        'Content-Type: text/plain',
        'Content-Transfer-Encoding: base64',
        'Content-Disposition: attachment; filename="../../../etc/passwd"',
        '',
        Buffer.from('safe content').toString('base64'),
        '',
        '--==test_boundary==--',
      ].join('\r\n'));

      imapStateInspector.injectMessage('[Gmail]/All Mail', dangerousFilenameEml, {
        xGmMsgId: '7770000000000001',
        xGmThrid: '7770000000000001',
        xGmLabels: ['\\Inbox', '\\All Mail'],
      });
      imapStateInspector.injectMessage('INBOX', dangerousFilenameEml, {
        xGmMsgId: '7770000000000001',
        xGmThrid: '7770000000000001',
        xGmLabels: ['\\Inbox'],
      });

      await triggerSyncAndWait(suiteAccountId, { timeout: 20_000 });

      const databaseService = DatabaseService.getInstance();
      const emailsNeedingBodies = databaseService.getEmailsNeedingBodies(suiteAccountId, 20);
      if (emailsNeedingBodies.length > 0) {
        await BodyPrefetchService.getInstance().fetchAndStoreBodies(suiteAccountId, emailsNeedingBodies);
      }

      // Get the attachment metadata, then fetch content so the cache path is exercised.
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        '7770000000000001',
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      expect(metaResponse.data).to.be.an('array');
      expect(metaResponse.data!.length).to.equal(1);

      const dangerousAttachment = metaResponse.data![0];
      const contentResponse = await callIpc(
        'attachment:get-content',
        dangerousAttachment.id,
      ) as IpcResponse<{ filename: string; content: string }>;

      expect(contentResponse.success).to.equal(true);
      expect(contentResponse.data!.filename).to.equal('../../../etc/passwd');
      expect(contentResponse.data!.content.length).to.be.greaterThan(0);

      const cachedAttachment = databaseService.getAttachmentById(dangerousAttachment.id);
      expect(cachedAttachment).to.not.be.null;
      expect(cachedAttachment!.localPath).to.be.a('string');
      expect(fs.existsSync(cachedAttachment!.localPath!)).to.equal(true);

      const expectedCacheDir = path.join(
        app.getPath('userData'),
        'attachments',
        String(suiteAccountId),
        String(dangerousAttachment.emailId),
      );
      const resolvedLocalPath = path.resolve(cachedAttachment!.localPath!);
      const resolvedCacheDir = path.resolve(expectedCacheDir);
      const cachedFilename = path.basename(cachedAttachment!.localPath!);

      expect(resolvedLocalPath.startsWith(`${resolvedCacheDir}${path.sep}`)).to.equal(true);
      expect(cachedFilename).to.not.equal(`${dangerousAttachment.id}_../../../etc/passwd`);
      expect(cachedFilename).to.include('etc_passwd');
    });
  });
});
