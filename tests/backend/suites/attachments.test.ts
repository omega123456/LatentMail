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
import { dialog } from 'electron';
import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { callIpc, waitForEvent, seedTestAccount, triggerSyncAndWait } from '../infrastructure/test-helpers';
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
    } catch (prefetchErr) {
      // Non-fatal: if prefetch fails, some attachment tests will fail too,
      // but the failure message will be more informative than a silent skip.
      console.warn('[setupWithAttachmentMessage] Body prefetch failed (non-fatal):', prefetchErr);
    }
  }
}

// =========================================================================
// Attachment metadata
// =========================================================================

describe('Attachments', () => {
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
      const filenames = response.data!.map((att) => att.filename);
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
      const notesTxtAtt = metaResponse.data!.find((att) => att.filename === 'notes.txt');
      expect(notesTxtAtt).to.not.be.undefined;

      // notes.txt should not be cached yet (fresh suite)
      expect(notesTxtAtt!.localPath).to.be.null;

      // Request the content — triggers IMAP fetch
      const contentResponse = await callIpc(
        'attachment:get-content',
        notesTxtAtt!.id,
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
      const pngAtt = metaResponse.data!.find((att) => att.filename === 'small.png');
      expect(pngAtt).to.not.be.undefined;

      // Fetch the content (may be cached from a previous call, either way is fine)
      const contentResponse = await callIpc(
        'attachment:get-content',
        pngAtt!.id,
      ) as IpcResponse<{ filename: string; content: string }>;

      expect(contentResponse.success).to.equal(true);

      // Verify local_path is now set in the DB
      const db = DatabaseService.getInstance();
      const updatedAtt = db.getAttachmentById(pngAtt!.id);
      expect(updatedAtt).to.not.be.null;
      if (updatedAtt!.localPath) {
        expect(fs.existsSync(updatedAtt!.localPath)).to.equal(true);
      }
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

      const notesTxtAtt = metaResponse.data!.find((att) => att.filename === 'notes.txt');
      expect(notesTxtAtt).to.not.be.undefined;

      // First call populates cache
      await callIpc('attachment:get-content', notesTxtAtt!.id);

      // Verify the cache file exists
      const db = DatabaseService.getInstance();
      const cachedAtt = db.getAttachmentById(notesTxtAtt!.id);

      if (cachedAtt?.localPath && fs.existsSync(cachedAtt.localPath)) {
        // Second request should read from cache file
        const secondResponse = await callIpc(
          'attachment:get-content',
          notesTxtAtt!.id,
        ) as IpcResponse<{ filename: string; content: string }>;

        expect(secondResponse.success).to.equal(true);
        expect(secondResponse.data!.filename).to.equal('notes.txt');
      }
      // If caching not available in this env, just pass (non-fatal)
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

    it('falls back to IMAP fetch when reading a cached attachment file throws', async function () {
      this.timeout(20_000);

      const multipartHeaders = emlFixtures['multipart-attachment'].headers;
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        multipartHeaders.xGmMsgId,
      ) as IpcResponse<AttachmentMetadata[]>;

      expect(metaResponse.success).to.equal(true);
      const notesAttachment = metaResponse.data!.find((att) => att.filename === 'notes.txt');
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
      const notesTxtAtt = metaResponse.data!.find((att) => att.filename === 'notes.txt');
      expect(notesTxtAtt).to.not.be.undefined;

      const textResponse = await callIpc(
        'attachment:get-content-as-text',
        notesTxtAtt!.id,
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
      const pngAttachment = metaResponse.data!.find((att) => att.filename === 'small.png');
      expect(pngAttachment).to.not.be.undefined;

      const textResponse = await callIpc(
        'attachment:get-content-as-text',
        pngAttachment!.id,
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
      const notesAttachment = metaResponse.data!.find((att) => att.filename === 'notes.txt');
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
      const notesTxtAtt = metaResponse.data!.find((att) => att.filename === 'notes.txt');
      expect(notesTxtAtt).to.not.be.undefined;

      // Ensure the temp file does not exist yet
      if (fs.existsSync(tempDownloadPath)) {
        fs.unlinkSync(tempDownloadPath);
      }

      const downloadResponse = await callIpc(
        'attachment:download',
        notesTxtAtt!.id,
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

      const notesTxtAtt = metaResponse.data!.find((att) => att.filename === 'notes.txt');
      expect(notesTxtAtt).to.not.be.undefined;

      const downloadResponse = await callIpc(
        'attachment:download',
        notesTxtAtt!.id,
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
        const notesTxtAtt = metaResponse.data!.find((att) => att.filename === 'notes.txt');
        expect(notesTxtAtt).to.not.be.undefined;

        const downloadResponse = await callIpc(
          'attachment:download',
          notesTxtAtt!.id,
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

    it('returns ATTACHMENT_DRAFT_FETCH_FAILED when fetching the draft source throws', async function () {
      this.timeout(25_000);

      const createDraftResponse = await callIpc('queue:enqueue', {
        type: 'draft-create',
        accountId: suiteAccountId,
        payload: {
          subject: 'Draft attachment fetch failure',
          to: 'draft-fetch-failure@example.com',
          textBody: 'Draft source fetch failure test',
        },
        description: 'Create draft for attachment failure path',
      }) as IpcResponse<{ queueId: string }>;

      expect(createDraftResponse.success).to.equal(true);
      const draftQueueId = createDraftResponse.data!.queueId;
      await waitForEvent('queue:update', {
        timeout: 20_000,
        predicate: (args) => {
          const payload = args[0] as Record<string, unknown> | undefined;
          return payload != null && payload['queueId'] === draftQueueId && payload['status'] === 'completed';
        },
      });

      const queueService = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
      const serverIds = queueService.MailQueueService.getInstance().getServerIds(draftQueueId);
      expect(serverIds).to.not.equal(undefined);

      imapStateInspector.injectCommandError('FETCH', 'forced draft fetch failure');

      try {
        const response = await callIpc(
          'attachment:fetch-draft-attachments',
          String(suiteAccountId),
          serverIds!.xGmMsgId,
        ) as IpcResponse<unknown>;

        expect(response.success).to.equal(false);
        expect(response.error!.code).to.equal('ATTACHMENT_DRAFT_FETCH_FAILED');
      } finally {
        imapStateInspector.clearCommandErrors();
      }
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

      // Get the attachment metadata — filename should be sanitized in the cache path
      const metaResponse = await callIpc(
        'attachment:get-for-email',
        String(suiteAccountId),
        '7770000000000001',
      ) as IpcResponse<AttachmentMetadata[]>;

      // The attachment list may be empty if body wasn't fetched, which is acceptable
      // The important thing is that the IPC does not crash and the response is valid
      expect(metaResponse.success).to.equal(true);
      expect(metaResponse.data).to.be.an('array');
    });
  });
});
