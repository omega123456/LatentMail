/**
 * db-model-integrity.test.ts — Database model integrity tests.
 *
 * Covers the following invariants at the DatabaseService layer:
 *
 *   1.  Email upsert body preservation (COALESCE guard)
 *   2.  Multi-folder email + thread-folder mapping
 *   3.  UIDVALIDITY reset cleanup (wipeFolderData)
 *   4.  MODSEQ tracking (upsertFolderState / getFolderState)
 *   5.  Trash folder resolution — Trash / Bin / fallback
 *   6.  is_filtered flag persistence
 *   7.  Body-only update idempotence (updateEmailBodyOnly guard)
 *   8.  Attachment deduplication (INSERT OR IGNORE)
 *   9.  AI cache TTL — hit / miss / invalidation
 *  10.  Orphan email cleanup (removeOrphanedEmails)
 *  11.  Orphan thread cleanup (removeOrphanedThreads)
 *  12.  Thread metadata recomputation (recomputeThreadMetadata)
 *  13.  Contact frequency + ordering (upsertContact / searchContacts)
 *  14.  Label CRUD + color + cascade (createLabel / deleteLabel / updateLabelColor)
 *  15.  Unread thread counts after flag changes
 *  16.  Embedding bookkeeping (vector_indexed_emails / embedding_crawl_progress)
 *  17.  Search helper edge cases (getEmailDatesByMsgIds / filterEmailsByMsgIds batching)
 *
 * Protocol:
 *   - before() hook calls quiesceAndRestore() once for the whole suite.
 *   - Individual tests use DB helpers directly to set up and tear down state.
 *   - Tests within the same describe() must not rely on execution order.
 */

import { expect } from 'chai';
import { DateTime } from 'luxon';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import { callIpc, getDatabase, seedTestAccount, waitForEvent } from '../infrastructure/test-helpers';
import { TestEventBus } from '../infrastructure/test-event-bus';
import { ollamaServer } from '../test-main';
import type { UpsertEmailInput, UpsertThreadInput } from '../../../electron/database/models';
import { VectorDbService } from '../../../electron/services/vector-db-service';

interface IpcResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string };
}

interface SearchBatchPayload {
  searchToken: string;
  phase: string;
  msgIds: string[];
}

interface SearchCompletePayload {
  searchToken: string;
  status: string;
  totalResults: number;
}

interface ChatDonePayload {
  requestId: string;
  success: boolean;
  cancelled: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Suite-level before hook
// ---------------------------------------------------------------------------

describe('DB Model Integrity', () => {
  before(async () => {
    await quiesceAndRestore();
  });

  // =========================================================================
  // Helpers
  // =========================================================================

  /**
   * Create a minimal account row and return its numeric ID.
   * Tests create accounts as needed and do not rely on a shared account.
   */
  function createTestAccount(suffix: string = 'default'): number {
    const db = getDatabase();
    return db.createAccount(`test-${suffix}@example.com`, `Test ${suffix}`, null);
  }

  /**
   * Build a minimal UpsertEmailInput for seeding the DB.
   * Callers may override any field via the overrides parameter.
   */
  function makeEmailInput(
    accountId: number,
    overrides: Partial<UpsertEmailInput> = {},
  ): UpsertEmailInput {
    return {
      accountId,
      xGmMsgId: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      xGmThrid: `thread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      folder: 'INBOX',
      fromAddress: 'alice@example.com',
      toAddresses: 'bob@example.com',
      date: '2024-01-01T10:00:00.000Z',
      isRead: false,
      isStarred: false,
      isImportant: false,
      hasAttachments: false,
      ...overrides,
    };
  }

  /**
   * Build a minimal UpsertThreadInput.
   */
  function makeThreadInput(
    accountId: number,
    xGmThrid: string,
    overrides: Partial<UpsertThreadInput> = {},
  ): UpsertThreadInput {
    return {
      accountId,
      xGmThrid,
      subject: 'Test subject',
      lastMessageDate: '2024-01-01T10:00:00.000Z',
      participants: 'alice@example.com',
      messageCount: 1,
      snippet: 'Test snippet',
      isRead: false,
      isStarred: false,
      ...overrides,
    };
  }

  async function runKeywordSearch(accountId: number, query: string): Promise<{
    complete: SearchCompletePayload;
    allMsgIds: string[];
  }> {
    const eventBus = TestEventBus.getInstance();
    const priorBatchCount = eventBus.getHistory('ai:search:batch').length;

    const response = await callIpc(
      'ai:search',
      String(accountId),
      query,
      undefined,
      'keyword',
    ) as IpcResponse<{ searchToken: string }>;

    expect(response.success).to.equal(true);
    const searchToken = response.data!.searchToken;

    const completeArgs = await waitForEvent('ai:search:complete', {
      timeout: 20_000,
      predicate: (args) => {
        const payload = args[0] as SearchCompletePayload | undefined;
        return payload != null && payload.searchToken === searchToken;
      },
    });

    const complete = completeArgs[0] as SearchCompletePayload;
    const batches = eventBus.getHistory('ai:search:batch')
      .slice(priorBatchCount)
      .map((record) => record.args[0] as SearchBatchPayload)
      .filter((payload) => payload != null && payload.searchToken === searchToken);

    return {
      complete,
      allMsgIds: batches.flatMap((payload) => payload.msgIds),
    };
  }

  async function configureInboxChatModels(): Promise<void> {
    const setUrlResponse = await callIpc('ai:set-url', ollamaServer.getBaseUrl()) as IpcResponse<{
      connected: boolean;
    }>;
    expect(setUrlResponse.success).to.equal(true);
    expect(setUrlResponse.data!.connected).to.equal(true);

    const setModelResponse = await callIpc(
      'ai:set-model',
      'llama3.2:latest',
    ) as IpcResponse<{ currentModel: string }>;
    expect(setModelResponse.success).to.equal(true);
    expect(setModelResponse.data!.currentModel).to.equal('llama3.2:latest');

    ollamaServer.setEmbedDimension(4);
    const setEmbeddingModelResponse = await callIpc(
      'ai:set-embedding-model',
      'nomic-embed-text:latest',
    ) as IpcResponse<{ embeddingModel: string; vectorDimension: number }>;
    expect(setEmbeddingModelResponse.success).to.equal(true);
    expect(setEmbeddingModelResponse.data!.embeddingModel).to.equal('nomic-embed-text:latest');
    expect(setEmbeddingModelResponse.data!.vectorDimension).to.equal(4);

    VectorDbService.getInstance().clearAllAndReconfigure(
      setEmbeddingModelResponse.data!.embeddingModel,
      setEmbeddingModelResponse.data!.vectorDimension,
    );
  }

  // =========================================================================
  // 1. Email upsert body preservation
  // =========================================================================

  describe('Email upsert body preservation', () => {
    it('preserves text_body on second upsert when new body is empty', () => {
      const db = getDatabase();
      const accountId = createTestAccount('body-preserve');
      const msgId = 'msg-body-preserve-001';

      // First upsert: include a body
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-body-preserve-001',
        textBody: 'Original body text',
        htmlBody: '<p>Original HTML</p>',
      }));

      // Second upsert: body fields intentionally omitted (simulate header-only sync)
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-body-preserve-001',
        textBody: undefined,
        htmlBody: undefined,
        subject: 'Updated subject',
      }));

      const email = db.getEmailByXGmMsgId(accountId, msgId);
      expect(email).to.not.be.null;
      expect(email!['textBody']).to.equal('Original body text');
      expect(email!['htmlBody']).to.equal('<p>Original HTML</p>');
      // Subject should be updated
      expect(email!['subject']).to.equal('Updated subject');
    });

    it('replaces empty body with non-empty body on re-upsert', () => {
      const db = getDatabase();
      const accountId = createTestAccount('body-replace');
      const msgId = 'msg-body-replace-001';

      // First upsert: no body
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-body-replace-001',
      }));

      // Second upsert: provide a body
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-body-replace-001',
        textBody: 'Now has body',
        htmlBody: '<p>Now has HTML</p>',
      }));

      const email = db.getEmailByXGmMsgId(accountId, msgId);
      expect(email!['textBody']).to.equal('Now has body');
      expect(email!['htmlBody']).to.equal('<p>Now has HTML</p>');
    });
  });

  // =========================================================================
  // 2. Multi-folder email + thread-folder mapping
  // =========================================================================

  describe('Multi-folder email and thread-folder mapping', () => {
    it('links a single email to multiple folders', () => {
      const db = getDatabase();
      const accountId = createTestAccount('multi-folder');
      const msgId = 'msg-multi-folder-001';
      const thrid = 'thread-multi-folder-001';

      // Insert in INBOX
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: thrid,
        folder: 'INBOX',
        folderUid: 101,
      }));

      // Add to [Gmail]/All Mail as well
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: thrid,
        folder: '[Gmail]/All Mail',
        folderUid: 201,
      }));

      const folders = db.getFoldersForEmail(accountId, msgId);
      expect(folders).to.include('INBOX');
      expect(folders).to.include('[Gmail]/All Mail');
    });

    it('upsertThreadFolder creates expected thread_folders rows', () => {
      const db = getDatabase();
      const accountId = createTestAccount('thread-folder-map');
      const thrid = 'thread-tfmap-001';

      db.upsertThread(makeThreadInput(accountId, thrid));

      db.upsertThreadFolder(accountId, thrid, 'INBOX');
      db.upsertThreadFolder(accountId, thrid, '[Gmail]/All Mail');

      const threadFolders = db.getFoldersForThread(accountId, thrid);
      expect(threadFolders).to.include('INBOX');
      expect(threadFolders).to.include('[Gmail]/All Mail');
    });

    it('getFolderUidsForEmail returns correct uid per folder', () => {
      const db = getDatabase();
      const accountId = createTestAccount('uid-per-folder');
      const msgId = 'msg-uid-per-folder-001';
      const thrid = 'thread-uid-per-folder-001';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: thrid,
        folder: 'INBOX',
        folderUid: 55,
      }));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: thrid,
        folder: '[Gmail]/Sent Mail',
        folderUid: 88,
      }));

      const uids = db.getFolderUidsForEmail(accountId, msgId);
      const inboxEntry = uids.find((entry) => entry.folder === 'INBOX');
      const sentEntry = uids.find((entry) => entry.folder === '[Gmail]/Sent Mail');
      expect(inboxEntry!.uid).to.equal(55);
      expect(sentEntry!.uid).to.equal(88);
    });
  });

  // =========================================================================
  // 3. UIDVALIDITY reset cleanup
  // =========================================================================

  describe('UIDVALIDITY reset cleanup (wipeFolderData)', () => {
    it('removes email_folders and thread_folders for a wiped folder', () => {
      const db = getDatabase();
      const accountId = createTestAccount('uidvalidity');
      const thrid = 'thread-uidv-001';

      db.upsertThread(makeThreadInput(accountId, thrid));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-uidv-001',
        xGmThrid: thrid,
        folder: 'INBOX',
        folderUid: 1,
      }));
      db.upsertThreadFolder(accountId, thrid, 'INBOX');

      // Confirm setup
      expect(db.getFoldersForEmail(accountId, 'msg-uidv-001')).to.include('INBOX');

      // Wipe INBOX
      db.wipeFolderData(accountId, 'INBOX');

      // Email-folder association must be gone
      expect(db.getFoldersForEmail(accountId, 'msg-uidv-001')).to.not.include('INBOX');
    });

    it('removes folder_state for the wiped folder', () => {
      const db = getDatabase();
      const accountId = createTestAccount('uidv-state');

      db.upsertFolderState({
        accountId,
        folder: 'INBOX',
        uidValidity: '100001',
        highestModseq: '500',
        condstoreSupported: true,
      });

      expect(db.getFolderState(accountId, 'INBOX')).to.not.be.null;

      db.wipeFolderData(accountId, 'INBOX');

      expect(db.getFolderState(accountId, 'INBOX')).to.be.null;
    });

    it('orphaned emails (no folder links) are cleaned up by wipeFolderData', () => {
      const db = getDatabase();
      const accountId = createTestAccount('uidv-orphan');
      const thrid = 'thread-uidv-orphan-001';

      // Seed an email that only exists in INBOX
      db.upsertThread(makeThreadInput(accountId, thrid));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-uidv-orphan-001',
        xGmThrid: thrid,
        folder: 'INBOX',
        folderUid: 10,
      }));
      db.upsertThreadFolder(accountId, thrid, 'INBOX');

      db.wipeFolderData(accountId, 'INBOX');

      // The orphaned email should be deleted by the wipe
      const email = db.getEmailByXGmMsgId(accountId, 'msg-uidv-orphan-001');
      expect(email).to.be.null;
    });
  });

  // =========================================================================
  // 4. MODSEQ tracking
  // =========================================================================

  describe('MODSEQ tracking (upsertFolderState / getFolderState)', () => {
    it('stores and retrieves highestModseq correctly', () => {
      const db = getDatabase();
      const accountId = createTestAccount('modseq');

      db.upsertFolderState({
        accountId,
        folder: 'INBOX',
        uidValidity: '9999',
        highestModseq: '123456789',
        condstoreSupported: true,
      });

      const state = db.getFolderState(accountId, 'INBOX');
      expect(state).to.not.be.null;
      expect(state!.highestModseq).to.equal('123456789');
      expect(state!.uidValidity).to.equal('9999');
      expect(state!.condstoreSupported).to.be.true;
    });

    it('upserts (updates) highestModseq on second call', () => {
      const db = getDatabase();
      const accountId = createTestAccount('modseq-update');

      db.upsertFolderState({
        accountId,
        folder: 'INBOX',
        uidValidity: '1001',
        highestModseq: '100',
      });
      db.upsertFolderState({
        accountId,
        folder: 'INBOX',
        uidValidity: '1001',
        highestModseq: '200',
      });

      const state = db.getFolderState(accountId, 'INBOX');
      expect(state!.highestModseq).to.equal('200');
    });

    it('stores NULL highestModseq for NOMODSEQ folders', () => {
      const db = getDatabase();
      const accountId = createTestAccount('nomodseq');

      db.upsertFolderState({
        accountId,
        folder: '[Gmail]/Spam',
        uidValidity: '777',
        highestModseq: null,
        condstoreSupported: false,
      });

      const state = db.getFolderState(accountId, '[Gmail]/Spam');
      expect(state!.highestModseq).to.be.null;
      expect(state!.condstoreSupported).to.be.false;
    });

    it('updateFolderStateNonModseq does not clobber highestModseq', () => {
      const db = getDatabase();
      const accountId = createTestAccount('nonmodseq-update');

      db.upsertFolderState({
        accountId,
        folder: 'INBOX',
        uidValidity: '555',
        highestModseq: '999',
        condstoreSupported: true,
      });

      db.updateFolderStateNonModseq(accountId, 'INBOX', '555', true);

      const state = db.getFolderState(accountId, 'INBOX');
      // highestModseq must be preserved (not overwritten to NULL)
      expect(state!.highestModseq).to.equal('999');
    });
  });

  // =========================================================================
  // 5. Trash folder resolution
  // =========================================================================

  describe('Trash folder resolution', () => {
    it('resolves to [Gmail]/Trash when no labels exist', () => {
      const db = getDatabase();
      const accountId = createTestAccount('trash-default');
      expect(db.getTrashFolder(accountId)).to.equal('[Gmail]/Trash');
    });

    it('resolves via special_use=\\Trash when present', () => {
      const db = getDatabase();
      const accountId = createTestAccount('trash-special-use');

      db.upsertLabel({
        accountId,
        gmailLabelId: '[Gmail]/Trash',
        name: 'Trash',
        type: 'system',
        unreadCount: 0,
        totalCount: 0,
        specialUse: '\\Trash',
      });

      expect(db.getTrashFolder(accountId)).to.equal('[Gmail]/Trash');
    });

    it('resolves to [Gmail]/Bin via legacy label id fallback', () => {
      const db = getDatabase();
      const accountId = createTestAccount('trash-bin');

      // Insert [Gmail]/Bin WITHOUT special_use so the legacy path is exercised
      db.upsertLabel({
        accountId,
        gmailLabelId: '[Gmail]/Bin',
        name: 'Bin',
        type: 'system',
        unreadCount: 0,
        totalCount: 0,
      });

      expect(db.getTrashFolder(accountId)).to.equal('[Gmail]/Bin');
    });

    it('special_use=\\Trash takes precedence over [Gmail]/Bin fallback', () => {
      const db = getDatabase();
      const accountId = createTestAccount('trash-priority');

      // Add Bin (legacy) first
      db.upsertLabel({
        accountId,
        gmailLabelId: '[Gmail]/Bin',
        name: 'Bin',
        type: 'system',
        unreadCount: 0,
        totalCount: 0,
      });

      // Then add Trash with special_use
      db.upsertLabel({
        accountId,
        gmailLabelId: '[Gmail]/Trash',
        name: 'Trash',
        type: 'system',
        unreadCount: 0,
        totalCount: 0,
        specialUse: '\\Trash',
      });

      // special_use path wins
      expect(db.getTrashFolder(accountId)).to.equal('[Gmail]/Trash');
    });

    it('falls back to [Gmail]/Trash for a seeded account before any labels sync', () => {
      const seeded = seedTestAccount({
        email: 'trash-fallback-seeded@example.com',
        displayName: 'Trash Fallback Seeded',
      });

      const db = getDatabase();
      const rawDb = db.getDatabase();
      const labelCount = rawDb.prepare(
        'SELECT COUNT(*) AS count FROM labels WHERE account_id = :accountId',
      ).get({ accountId: seeded.accountId }) as { count: number };

      expect(labelCount.count).to.equal(0);
      expect(db.getTrashFolder(seeded.accountId)).to.equal('[Gmail]/Trash');
    });
  });

  // =========================================================================
  // 6. is_filtered flag persistence
  // =========================================================================

  describe('is_filtered flag persistence', () => {
    it('emails default to is_filtered=false on insert', () => {
      const db = getDatabase();
      const accountId = createTestAccount('filtered-default');
      const msgId = 'msg-filtered-default-001';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-filtered-001',
      }));

      const rawDb = db.getDatabase();
      const row = rawDb.prepare(
        'SELECT is_filtered FROM emails WHERE account_id = :accountId AND x_gm_msgid = :msgId'
      ).get({ accountId, msgId }) as { is_filtered: number } | undefined;
      expect(row).to.not.be.undefined;
      expect(row!.is_filtered).to.equal(0);
    });

    it('markEmailsAsFiltered sets is_filtered=1 for the given email IDs', () => {
      const db = getDatabase();
      const accountId = createTestAccount('filtered-mark');
      const msgId = 'msg-filtered-mark-001';

      const emailId = db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-filtered-mark-001',
      }));

      db.markEmailsAsFiltered([emailId]);

      const rawDb = db.getDatabase();
      const row = rawDb.prepare(
        'SELECT is_filtered FROM emails WHERE id = :emailId'
      ).get({ emailId }) as { is_filtered: number } | undefined;
      expect(row!.is_filtered).to.equal(1);
    });

    it('getUnfilteredInboxEmails does not return filtered emails', () => {
      const db = getDatabase();
      const accountId = createTestAccount('filtered-query');

      const unfilteredId = db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-unfiltered-001',
        xGmThrid: 'thread-unfiltered-001',
        folder: 'INBOX',
      }));
      const filteredId = db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-filtered-query-001',
        xGmThrid: 'thread-filtered-query-001',
        folder: 'INBOX',
      }));

      db.markEmailsAsFiltered([filteredId]);

      const unfiltered = db.getUnfilteredInboxEmails(accountId);
      const xGmMsgIds = unfiltered.map((email) => email.xGmMsgId);
      expect(xGmMsgIds).to.include('msg-unfiltered-001');
      expect(xGmMsgIds).to.not.include('msg-filtered-query-001');
      void unfilteredId; // used via DB query
    });
  });

  // =========================================================================
  // 7. Body-only update idempotence
  // =========================================================================

  describe('Body-only update idempotence', () => {
    it('updateEmailBodyOnly fills empty body correctly', () => {
      const db = getDatabase();
      const accountId = createTestAccount('body-only');
      const msgId = 'msg-body-only-001';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-body-only-001',
      }));

      db.updateEmailBodyOnly(accountId, msgId, 'Fetched text', '<p>Fetched HTML</p>');

      const email = db.getEmailByXGmMsgId(accountId, msgId);
      expect(email!['textBody']).to.equal('Fetched text');
      expect(email!['htmlBody']).to.equal('<p>Fetched HTML</p>');
    });

    it('updateEmailBodyOnly does NOT overwrite an existing non-empty body', () => {
      const db = getDatabase();
      const accountId = createTestAccount('body-only-idempotent');
      const msgId = 'msg-body-only-idempotent-001';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-body-only-idempotent-001',
        textBody: 'Already has text',
        htmlBody: '<p>Already has HTML</p>',
      }));

      // This call should be a no-op because body is already set
      db.updateEmailBodyOnly(accountId, msgId, 'Overwrite attempt', '<p>Overwrite</p>');

      const email = db.getEmailByXGmMsgId(accountId, msgId);
      expect(email!['textBody']).to.equal('Already has text');
      expect(email!['htmlBody']).to.equal('<p>Already has HTML</p>');
    });
  });

  // =========================================================================
  // 8. Attachment deduplication
  // =========================================================================

  describe('Attachment deduplication', () => {
    it('inserts attachment rows once and ignores duplicates', () => {
      const db = getDatabase();
      const accountId = createTestAccount('att-dedup');
      const msgId = 'msg-att-dedup-001';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-att-dedup-001',
        hasAttachments: true,
      }));

      const att = { filename: 'report.pdf', mimeType: 'application/pdf', size: 1024, contentId: null };

      // Insert twice — second call must be ignored (INSERT OR IGNORE)
      db.upsertAttachmentsForEmail(accountId, msgId, [att]);
      db.upsertAttachmentsForEmail(accountId, msgId, [att]);

      const attachments = db.getAttachmentsForEmail(accountId, msgId);
      // Exactly one row should exist
      expect(attachments).to.have.length(1);
      expect(attachments[0].filename).to.equal('report.pdf');
    });

    it('stores multiple distinct attachments for the same email', () => {
      const db = getDatabase();
      const accountId = createTestAccount('att-multi');
      const msgId = 'msg-att-multi-001';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-att-multi-001',
        hasAttachments: true,
      }));

      db.upsertAttachmentsForEmail(accountId, msgId, [
        { filename: 'doc1.pdf', mimeType: 'application/pdf', size: 100, contentId: null },
        { filename: 'doc2.pdf', mimeType: 'application/pdf', size: 200, contentId: null },
        { filename: 'photo.png', mimeType: 'image/png', size: 300, contentId: null },
      ]);

      const attachments = db.getAttachmentsForEmail(accountId, msgId);
      expect(attachments).to.have.length(3);
      const filenames = attachments.map((att) => att.filename).sort();
      expect(filenames).to.deep.equal(['doc1.pdf', 'doc2.pdf', 'photo.png']);
    });

    it('differentiates attachments with the same filename but different contentId', () => {
      const db = getDatabase();
      const accountId = createTestAccount('att-contentid');
      const msgId = 'msg-att-contentid-001';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-att-contentid-001',
        hasAttachments: true,
      }));

      db.upsertAttachmentsForEmail(accountId, msgId, [
        { filename: 'inline.png', mimeType: 'image/png', size: 50, contentId: '<img001@example.com>' },
        { filename: 'inline.png', mimeType: 'image/png', size: 50, contentId: '<img002@example.com>' },
      ]);

      const attachments = db.getAttachmentsForEmail(accountId, msgId);
      expect(attachments).to.have.length(2);
    });
  });

  // =========================================================================
  // 9. AI cache TTL — hit / miss / invalidation
  // =========================================================================

  describe('AI cache TTL', () => {
    it('returns cached result on cache hit (no expiry)', () => {
      const db = getDatabase();
      db.setAiCacheResult('summarize', 'hash-001', 'llama3', 'Summary text', null);
      const result = db.getAiCacheResult('summarize', 'hash-001', 'llama3');
      expect(result).to.equal('Summary text');
    });

    it('returns null on cache miss (unknown hash)', () => {
      const db = getDatabase();
      const result = db.getAiCacheResult('summarize', 'hash-nonexistent', 'llama3');
      expect(result).to.be.null;
    });

    it('returns null on cache miss (different operation)', () => {
      const db = getDatabase();
      db.setAiCacheResult('summarize', 'hash-op-002', 'llama3', 'text', null);
      const result = db.getAiCacheResult('compose', 'hash-op-002', 'llama3');
      expect(result).to.be.null;
    });

    it('returns null on cache miss (different model)', () => {
      const db = getDatabase();
      db.setAiCacheResult('summarize', 'hash-model-003', 'llama3', 'text', null);
      const result = db.getAiCacheResult('summarize', 'hash-model-003', 'mistral');
      expect(result).to.be.null;
    });

    it('returns null for an expired entry (TTL = 0 days in the past)', () => {
      const db = getDatabase();
      // Insert a row that expires immediately (0 days = expires now)
      // We use direct SQL to insert a past-expired entry
      const rawDb = db.getDatabase();
      rawDb.prepare(
        `INSERT OR REPLACE INTO ai_cache (operation_type, input_hash, model, result, expires_at, created_at)
         VALUES ('summarize', 'hash-expired-001', 'llama3', 'stale text', datetime('now', '-1 day'), datetime('now', '-2 days'))`
      ).run();

      const result = db.getAiCacheResult('summarize', 'hash-expired-001', 'llama3');
      expect(result).to.be.null;
    });

    it('returns the result for a non-expired entry', () => {
      const db = getDatabase();
      // Insert a row that expires in the future
      const rawDb = db.getDatabase();
      rawDb.prepare(
        `INSERT OR REPLACE INTO ai_cache (operation_type, input_hash, model, result, expires_at, created_at)
         VALUES ('summarize', 'hash-valid-ttl-001', 'llama3', 'fresh text', datetime('now', '+7 days'), datetime('now'))`
      ).run();

      const result = db.getAiCacheResult('summarize', 'hash-valid-ttl-001', 'llama3');
      expect(result).to.equal('fresh text');
    });

    it('invalidateAiCache by operation clears all matching entries', () => {
      const db = getDatabase();
      db.setAiCacheResult('summarize', 'hash-inv-a', 'llama3', 'text a', null);
      db.setAiCacheResult('summarize', 'hash-inv-b', 'llama3', 'text b', null);
      db.setAiCacheResult('compose', 'hash-inv-c', 'llama3', 'text c', null);

      db.invalidateAiCache('summarize');

      expect(db.getAiCacheResult('summarize', 'hash-inv-a', 'llama3')).to.be.null;
      expect(db.getAiCacheResult('summarize', 'hash-inv-b', 'llama3')).to.be.null;
      // compose entry must not be affected
      expect(db.getAiCacheResult('compose', 'hash-inv-c', 'llama3')).to.equal('text c');
    });

    it('invalidateAiCache by operation + inputHash removes only the matching row', () => {
      const db = getDatabase();
      db.setAiCacheResult('summarize', 'hash-specific-001', 'llama3', 'specific', null);
      db.setAiCacheResult('summarize', 'hash-specific-002', 'llama3', 'keep me', null);

      db.invalidateAiCache('summarize', 'hash-specific-001');

      expect(db.getAiCacheResult('summarize', 'hash-specific-001', 'llama3')).to.be.null;
      expect(db.getAiCacheResult('summarize', 'hash-specific-002', 'llama3')).to.equal('keep me');
    });

    it('clearExpiredAiCache removes only expired rows', () => {
      const db = getDatabase();
      const rawDb = db.getDatabase();

      // Insert one expired and one valid
      rawDb.prepare(
        `INSERT OR REPLACE INTO ai_cache (operation_type, input_hash, model, result, expires_at, created_at)
         VALUES ('compose', 'hash-clear-exp-001', 'llama3', 'expired', datetime('now', '-1 hour'), datetime('now', '-2 hours'))`
      ).run();
      db.setAiCacheResult('compose', 'hash-clear-exp-002', 'llama3', 'valid forever', null);

      db.clearExpiredAiCache();

      expect(db.getAiCacheResult('compose', 'hash-clear-exp-001', 'llama3')).to.be.null;
      expect(db.getAiCacheResult('compose', 'hash-clear-exp-002', 'llama3')).to.equal('valid forever');
    });
  });

  // =========================================================================
  // 10. Orphan email cleanup
  // =========================================================================

  describe('Orphan email cleanup (removeOrphanedEmails)', () => {
    it('removes emails with no email_folders associations when bypassGracePeriod=true', () => {
      const db = getDatabase();
      const accountId = createTestAccount('orphan-email');
      const thrid = 'thread-orphan-email-001';

      // Insert email + thread
      db.upsertThread(makeThreadInput(accountId, thrid));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-orphan-email-001',
        xGmThrid: thrid,
        folder: 'INBOX',
        folderUid: 1,
      }));

      // Manually remove the email_folders row to create an orphan
      const rawDb = db.getDatabase();
      rawDb.prepare(
        'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :msgId'
      ).run({ accountId, msgId: 'msg-orphan-email-001' });

      // Confirm it's now orphaned
      const orphaned = rawDb.prepare(
        `SELECT COUNT(*) AS cnt FROM emails
         WHERE account_id = :accountId AND x_gm_msgid NOT IN (
           SELECT x_gm_msgid FROM email_folders WHERE account_id = :accountId
         )`
      ).get({ accountId }) as { cnt: number };
      expect(orphaned.cnt).to.be.greaterThan(0);

      const removed = db.removeOrphanedEmails(accountId, true);
      expect(removed.some((entry) => entry.xGmMsgId === 'msg-orphan-email-001')).to.be.true;

      // Email must be gone
      expect(db.getEmailByXGmMsgId(accountId, 'msg-orphan-email-001')).to.be.null;
    });

    it('does not remove emails with active folder associations', () => {
      const db = getDatabase();
      const accountId = createTestAccount('orphan-email-keep');
      const msgId = 'msg-orphan-keep-001';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: 'thread-orphan-keep-001',
        folder: 'INBOX',
      }));

      db.removeOrphanedEmails(accountId, true);

      // Should still exist
      expect(db.getEmailByXGmMsgId(accountId, msgId)).to.not.be.null;
    });
  });

  // =========================================================================
  // 11. Orphan thread cleanup
  // =========================================================================

  describe('Orphan thread cleanup (removeOrphanedThreads)', () => {
    it('removes threads with no thread_folders associations when bypassGracePeriod=true', () => {
      const db = getDatabase();
      const accountId = createTestAccount('orphan-thread');
      const thrid = 'thread-orphan-thread-001';

      // Create thread with no thread_folders entry
      db.upsertThread(makeThreadInput(accountId, thrid));

      // Confirm thread exists
      expect(db.getThreadById(accountId, thrid)).to.not.be.null;

      const count = db.removeOrphanedThreads(accountId, true);
      expect(count).to.be.greaterThan(0);

      // Thread must be gone
      expect(db.getThreadById(accountId, thrid)).to.be.null;
    });

    it('does not remove threads that have thread_folders entries', () => {
      const db = getDatabase();
      const accountId = createTestAccount('orphan-thread-keep');
      const thrid = 'thread-orphan-thread-keep-001';

      db.upsertThread(makeThreadInput(accountId, thrid));
      db.upsertThreadFolder(accountId, thrid, 'INBOX');

      db.removeOrphanedThreads(accountId, true);

      // Should still exist
      expect(db.getThreadById(accountId, thrid)).to.not.be.null;
    });
  });

  // =========================================================================
  // 12. Thread metadata recomputation
  // =========================================================================

  describe('Thread metadata recomputation (recomputeThreadMetadata)', () => {
    it('updates message_count based on actual email rows', () => {
      const db = getDatabase();
      const accountId = createTestAccount('thread-meta-count');
      const thrid = 'thread-meta-count-001';

      // Seed thread with wrong count
      db.upsertThread(makeThreadInput(accountId, thrid, { messageCount: 99 }));

      // Insert 2 actual emails
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-count-001',
        xGmThrid: thrid,
        folder: 'INBOX',
      }));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-count-002',
        xGmThrid: thrid,
        folder: 'INBOX',
      }));

      db.recomputeThreadMetadata(accountId, thrid);

      const thread = db.getThreadById(accountId, thrid);
      expect(thread!['messageCount']).to.equal(2);
    });

    it('updates is_read based on all emails in the thread', () => {
      const db = getDatabase();
      const accountId = createTestAccount('thread-meta-read');
      const thrid = 'thread-meta-read-001';

      db.upsertThread(makeThreadInput(accountId, thrid));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-read-001',
        xGmThrid: thrid,
        folder: 'INBOX',
        isRead: true,
      }));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-read-002',
        xGmThrid: thrid,
        folder: 'INBOX',
        isRead: false,
      }));

      db.recomputeThreadMetadata(accountId, thrid);

      // Thread should be unread (at least one unread email)
      const thread = db.getThreadById(accountId, thrid);
      expect(thread!['isRead']).to.be.false;
    });

    it('deletes thread and thread_folders if all emails are removed', () => {
      const db = getDatabase();
      const accountId = createTestAccount('thread-meta-delete');
      const thrid = 'thread-meta-delete-001';

      db.upsertThread(makeThreadInput(accountId, thrid));
      db.upsertThreadFolder(accountId, thrid, 'INBOX');
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-delete-001',
        xGmThrid: thrid,
        folder: 'INBOX',
      }));

      // Remove the email, then recompute
      const rawDb = db.getDatabase();
      rawDb.prepare(
        'DELETE FROM email_folders WHERE account_id = :accountId AND x_gm_msgid = :msgId'
      ).run({ accountId, msgId: 'msg-meta-delete-001' });
      rawDb.prepare(
        'DELETE FROM emails WHERE account_id = :accountId AND x_gm_msgid = :msgId'
      ).run({ accountId, msgId: 'msg-meta-delete-001' });

      db.recomputeThreadMetadata(accountId, thrid);

      // Thread should be deleted
      expect(db.getThreadById(accountId, thrid)).to.be.null;
    });

    it('updates snippet to the most recent email snippet', () => {
      const db = getDatabase();
      const accountId = createTestAccount('thread-meta-snippet');
      const thrid = 'thread-meta-snippet-001';

      db.upsertThread(makeThreadInput(accountId, thrid));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-snip-001',
        xGmThrid: thrid,
        folder: 'INBOX',
        date: '2024-01-01T09:00:00.000Z',
        snippet: 'Older snippet',
      }));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-snip-002',
        xGmThrid: thrid,
        folder: 'INBOX',
        date: '2024-01-01T10:00:00.000Z',
        snippet: 'Newer snippet',
      }));

      db.recomputeThreadMetadata(accountId, thrid);

      const thread = db.getThreadById(accountId, thrid);
      expect(thread!['snippet']).to.equal('Newer snippet');
    });

    it('formats mixed participant names with null and email-equals-name values', () => {
      const db = getDatabase();
      const accountId = createTestAccount('thread-meta-participants');
      const thrid = 'thread-meta-participants-001';

      db.upsertThread(makeThreadInput(accountId, thrid, { participants: 'stale participants' }));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-participants-001',
        xGmThrid: thrid,
        folder: 'INBOX',
        date: DateTime.utc(2026, 3, 12, 12, 0, 0).toISO()!,
        fromAddress: 'same@example.com',
        fromName: 'same@example.com',
      }));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-participants-002',
        xGmThrid: thrid,
        folder: 'INBOX',
        date: DateTime.utc(2026, 3, 12, 11, 0, 0).toISO()!,
        fromAddress: 'named@example.com',
        fromName: 'Named Person',
      }));
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: 'msg-meta-participants-003',
        xGmThrid: thrid,
        folder: 'INBOX',
        date: DateTime.utc(2026, 3, 12, 10, 0, 0).toISO()!,
        fromAddress: 'nullname@example.com',
      }));
      db.getDatabase().prepare(
        'UPDATE emails SET from_name = NULL WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId',
      ).run({
        accountId,
        xGmMsgId: 'msg-meta-participants-003',
      });

      db.recomputeThreadMetadata(accountId, thrid);

      const thread = db.getThreadById(accountId, thrid);
      expect(thread).to.not.be.null;
      expect(thread!['participants']).to.equal(
        'same@example.com, Named Person <named@example.com>, nullname@example.com',
      );
    });
  });

  // =========================================================================
  // 13. Contact frequency + ordering
  // =========================================================================

  describe('Contact frequency and ordering', () => {
    it('upsertContact increments frequency on repeated calls', () => {
      const db = getDatabase();
      db.upsertContact('frequent@example.com', 'Frequent User');
      db.upsertContact('frequent@example.com', 'Frequent User');
      db.upsertContact('frequent@example.com', 'Frequent User');

      const results = db.searchContacts('frequent@example.com');
      expect(results).to.have.length.greaterThan(0);
      const contact = results[0] as { email: string; frequency: number };
      expect(contact.email).to.equal('frequent@example.com');
      expect(contact.frequency).to.equal(3);
    });

    it('orders contacts by frequency DESC', () => {
      const db = getDatabase();
      const suffix = Date.now().toString();
      const rareEmail = `rare-${suffix}@example.com`;
      const commonEmail = `common-${suffix}@example.com`;

      db.upsertContact(rareEmail, 'Rare Contact');
      db.upsertContact(commonEmail, 'Common Contact');
      db.upsertContact(commonEmail, 'Common Contact');
      db.upsertContact(commonEmail, 'Common Contact');

      const results = db.searchContacts(`-${suffix}@example.com`) as Array<{ email: string; frequency: number }>;
      expect(results.length).to.be.greaterThanOrEqual(2);

      const commonIndex = results.findIndex((contact) => contact.email === commonEmail);
      const rareIndex = results.findIndex((contact) => contact.email === rareEmail);
      expect(commonIndex).to.be.lessThan(rareIndex);
    });

    it('upsertContact preserves the first non-null display name', () => {
      const db = getDatabase();
      db.upsertContact('named@example.com', 'Original Name');
      db.upsertContact('named@example.com', undefined);

      const results = db.searchContacts('named@example.com') as Array<{ email: string; displayName: string }>;
      expect(results[0].displayName).to.equal('Original Name');
    });

    it('searchContacts returns empty array for no match', () => {
      const db = getDatabase();
      const results = db.searchContacts('nomatchwhatsoever12345');
      expect(results).to.be.an('array').with.length(0);
    });

    it('increments frequency when the same address is upserted with duplicate entries', () => {
      const db = getDatabase();
      const duplicateEmail = `duplicate-contact-${DateTime.utc().toMillis()}@example.com`;

      db.upsertContact(duplicateEmail, 'Duplicate Contact');
      db.upsertContact(duplicateEmail, 'Duplicate Contact');
      db.upsertContact(duplicateEmail, undefined);

      const results = db.searchContacts(duplicateEmail) as Array<{
        email: string;
        frequency: number;
        displayName: string;
      }>;

      expect(results[0]!.email).to.equal(duplicateEmail);
      expect(results[0]!.frequency).to.equal(3);
      expect(results[0]!.displayName).to.equal('Duplicate Contact');
    });
  });

  // =========================================================================
  // 17. Search query coverage through ai:search keyword mode
  // =========================================================================

  describe('Search query coverage through ai:search keyword mode', () => {
    it('routes keyword queries through DatabaseService search paths for direct operators', async function () {
      this.timeout(25_000);

      const seeded = seedTestAccount({
        email: 'db-keyword-operators@example.com',
        displayName: 'DB Keyword Operators',
      });
      const db = getDatabase();

      db.upsertLabel({
        accountId: seeded.accountId,
        gmailLabelId: 'Projects/Database',
        name: 'Database Project',
        type: 'user',
        unreadCount: 0,
        totalCount: 0,
      });

      db.upsertThread(makeThreadInput(seeded.accountId, 'thread-db-keyword-001', {
        subject: 'Database operator subject',
        lastMessageDate: DateTime.utc(2026, 3, 1, 10, 0, 0).toISO()!,
        participants: 'Operator Sender <operator-sender@example.com>',
      }));
      db.upsertEmail(makeEmailInput(seeded.accountId, {
        xGmMsgId: 'db-keyword-msg-001',
        xGmThrid: 'thread-db-keyword-001',
        folder: 'Projects/Database',
        fromAddress: 'operator-sender@example.com',
        fromName: 'Operator Sender',
        toAddresses: 'operator-recipient@example.com',
        subject: 'Database operator subject',
        textBody: 'contains unique-body-marker and parser coverage',
        date: DateTime.utc(2026, 3, 1, 10, 0, 0).toISO()!,
        isRead: false,
        isStarred: true,
        isImportant: true,
        hasAttachments: true,
      }));

      const fromSearch = await runKeywordSearch(seeded.accountId, 'from:operator-sender@example.com Database operator subject');
      const toSearch = await runKeywordSearch(seeded.accountId, 'to:operator-recipient@example.com Database operator subject');
      const subjectSearch = await runKeywordSearch(seeded.accountId, 'subject:"Database operator subject"');
      const bodySearch = await runKeywordSearch(seeded.accountId, 'body:unique-body-marker');
      const labelSearch = await runKeywordSearch(seeded.accountId, 'label:"Database Project"');
      const unreadSearch = await runKeywordSearch(seeded.accountId, 'is:unread Database operator subject');
      const starredSearch = await runKeywordSearch(seeded.accountId, 'is:starred Database operator subject');
      const importantSearch = await runKeywordSearch(seeded.accountId, 'is:important Database operator subject');
      const attachmentSearch = await runKeywordSearch(seeded.accountId, 'has:attachment Database operator subject');

      for (const searchResult of [
        fromSearch,
        toSearch,
        subjectSearch,
        bodySearch,
        labelSearch,
        unreadSearch,
        starredSearch,
        importantSearch,
        attachmentSearch,
      ]) {
        expect(searchResult.complete.status).to.equal('complete');
        expect(searchResult.allMsgIds).to.include('db-keyword-msg-001');
      }
    });

    it('handles date, negation, folder alias, unknown operator, phrase, and wildcard keyword queries', async function () {
      this.timeout(25_000);

      const seeded = seedTestAccount({
        email: 'db-keyword-advanced@example.com',
        displayName: 'DB Keyword Advanced',
      });
      const db = getDatabase();

      db.upsertThread(makeThreadInput(seeded.accountId, 'thread-db-keyword-002', {
        subject: 'advanced wildcard 100%_done',
        lastMessageDate: DateTime.utc(2026, 2, 10, 8, 0, 0).toISO()!,
        participants: 'Allowed Sender <allowed@example.com>',
      }));
      db.upsertEmail(makeEmailInput(seeded.accountId, {
        xGmMsgId: 'db-keyword-msg-002',
        xGmThrid: 'thread-db-keyword-002',
        folder: 'INBOX',
        fromAddress: 'allowed@example.com',
        fromName: 'Allowed Sender',
        subject: 'advanced wildcard 100%_done',
        textBody: 'exact quarterly planning review and mystery:literal token',
        date: DateTime.utc(2026, 2, 10, 8, 0, 0).toISO()!,
        isRead: false,
      }));

      db.upsertLabel({
        accountId: seeded.accountId,
        gmailLabelId: '[Gmail]/Bin',
        name: 'Trash',
        type: 'system',
        unreadCount: 0,
        totalCount: 0,
        specialUse: '\\Trash',
      });
      db.upsertThread(makeThreadInput(seeded.accountId, 'thread-db-keyword-003', {
        subject: 'advanced wildcard 100X_done',
        lastMessageDate: DateTime.utc(2026, 1, 1, 8, 0, 0).toISO()!,
        participants: 'Blocked Sender <blocked@example.com>',
      }));
      db.upsertEmail(makeEmailInput(seeded.accountId, {
        xGmMsgId: 'db-keyword-msg-003',
        xGmThrid: 'thread-db-keyword-003',
        folder: '[Gmail]/Bin',
        fromAddress: 'blocked@example.com',
        fromName: 'Blocked Sender',
        subject: 'advanced wildcard 100X_done',
        textBody: 'blocked mystery:literal content',
        date: DateTime.utc(2026, 1, 1, 8, 0, 0).toISO()!,
        isRead: true,
      }));

      const afterSearch = await runKeywordSearch(seeded.accountId, 'after:2026/02/01 advanced');
      const beforeSearch = await runKeywordSearch(seeded.accountId, 'before:2026/03/01 advanced');
      const negatedFromSearch = await runKeywordSearch(seeded.accountId, '-from:blocked@example.com advanced');
      const negatedReadSearch = await runKeywordSearch(seeded.accountId, '-is:read advanced');
      const inboxAliasSearch = await runKeywordSearch(seeded.accountId, 'in:inbox advanced');
      const trashAliasSearch = await runKeywordSearch(seeded.accountId, 'in:trash 100X_done');
      const unknownOperatorSearch = await runKeywordSearch(seeded.accountId, 'mystery:literal advanced');
      const phraseSearch = await runKeywordSearch(seeded.accountId, '"quarterly planning review" advanced');
      const wildcardSearch = await runKeywordSearch(seeded.accountId, 'subject:100%_done advanced');

      expect(afterSearch.allMsgIds).to.include('db-keyword-msg-002');
      expect(beforeSearch.allMsgIds).to.include('db-keyword-msg-002');
      expect(beforeSearch.allMsgIds).to.not.include('db-keyword-msg-003');
      expect(negatedFromSearch.allMsgIds).to.include('db-keyword-msg-002');
      expect(negatedFromSearch.allMsgIds).to.not.include('db-keyword-msg-003');
      expect(negatedReadSearch.allMsgIds).to.include('db-keyword-msg-002');
      expect(inboxAliasSearch.allMsgIds).to.include('db-keyword-msg-002');
      expect(trashAliasSearch.complete.status).to.equal('complete');
      expect(trashAliasSearch.allMsgIds).to.deep.equal([]);
      expect(unknownOperatorSearch.allMsgIds).to.include('db-keyword-msg-002');
      expect(phraseSearch.allMsgIds).to.include('db-keyword-msg-002');
      expect(wildcardSearch.allMsgIds).to.include('db-keyword-msg-002');
      expect(wildcardSearch.allMsgIds).to.not.include('db-keyword-msg-003');
    });
  });

  // =========================================================================
  // 14. Label CRUD + color + cascade
  // =========================================================================

  describe('Label CRUD + color + cascade', () => {
    it('createLabel inserts a label row with correct fields', () => {
      const db = getDatabase();
      const accountId = createTestAccount('label-crud');

      const labelId = db.createLabel(accountId, 'MyLabel', 'My Label', '#ff0000');
      expect(labelId).to.be.a('number').greaterThan(0);

      const label = db.getLabelByGmailId(accountId, 'MyLabel') as { name: string; color: string; type: string } | null;
      expect(label).to.not.be.null;
      expect(label!.name).to.equal('My Label');
      expect(label!.color).to.equal('#ff0000');
      expect(label!.type).to.equal('user');
    });

    it('updateLabelColor changes the label color', () => {
      const db = getDatabase();
      const accountId = createTestAccount('label-color');

      db.createLabel(accountId, 'ColorLabel', 'Color Label', '#ff0000');
      db.updateLabelColor(accountId, 'ColorLabel', '#00ff00');

      const label = db.getLabelByGmailId(accountId, 'ColorLabel') as { color: string } | null;
      expect(label!.color).to.equal('#00ff00');
    });

    it('updateLabelColor sets color to null when passed null', () => {
      const db = getDatabase();
      const accountId = createTestAccount('label-color-null');

      db.createLabel(accountId, 'NullColorLabel', 'Null Color Label', '#ff0000');
      db.updateLabelColor(accountId, 'NullColorLabel', null);

      const label = db.getLabelByGmailId(accountId, 'NullColorLabel') as { color: string | null } | null;
      expect(label!.color).to.be.null;
    });

    it('deleteLabel removes the label row', () => {
      const db = getDatabase();
      const accountId = createTestAccount('label-delete');

      db.createLabel(accountId, 'DeleteMe', 'Delete Me', null);
      expect(db.getLabelByGmailId(accountId, 'DeleteMe')).to.not.be.null;

      db.deleteLabel(accountId, 'DeleteMe');
      expect(db.getLabelByGmailId(accountId, 'DeleteMe')).to.be.null;
    });

    it('deleteLabel cascades to email_folders and thread_folders', () => {
      const db = getDatabase();
      const accountId = createTestAccount('label-cascade');
      const thrid = 'thread-label-cascade-001';
      const msgId = 'msg-label-cascade-001';

      // Create the label
      db.createLabel(accountId, 'CascadeLabel', 'Cascade Label', null);

      // Associate email and thread with the label-as-folder
      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: msgId,
        xGmThrid: thrid,
        folder: 'CascadeLabel',
      }));
      db.upsertThread(makeThreadInput(accountId, thrid));
      db.upsertThreadFolder(accountId, thrid, 'CascadeLabel');

      // Delete the label
      db.deleteLabel(accountId, 'CascadeLabel');

      // Verify cascade: email_folders and thread_folders rows for this label are gone
      const rawDb = db.getDatabase();
      const efCount = rawDb.prepare(
        `SELECT COUNT(*) AS cnt FROM email_folders WHERE account_id = :accountId AND folder = 'CascadeLabel'`
      ).get({ accountId }) as { cnt: number };
      expect(efCount.cnt).to.equal(0);

      const tfCount = rawDb.prepare(
        `SELECT COUNT(*) AS cnt FROM thread_folders WHERE account_id = :accountId AND folder = 'CascadeLabel'`
      ).get({ accountId }) as { cnt: number };
      expect(tfCount.cnt).to.equal(0);
    });

    it('upsertLabel preserves existing color when new color is null', () => {
      const db = getDatabase();
      const accountId = createTestAccount('label-upsert-color');

      db.upsertLabel({
        accountId,
        gmailLabelId: 'INBOX',
        name: 'INBOX',
        type: 'system',
        color: '#aabbcc',
        unreadCount: 10,
        totalCount: 50,
      });

      // Second upsert without color — should preserve existing color
      db.upsertLabel({
        accountId,
        gmailLabelId: 'INBOX',
        name: 'INBOX',
        type: 'system',
        unreadCount: 12,
        totalCount: 52,
      });

      const label = db.getLabelByGmailId(accountId, 'INBOX') as { color: string | null } | null;
      expect(label!.color).to.equal('#aabbcc');
    });
  });

  // =========================================================================
  // 15. Unread thread counts after flag changes
  // =========================================================================

  describe('Unread thread counts after flag changes', () => {
    it('getUnreadThreadCountsByFolder includes unread threads', () => {
      const db = getDatabase();
      const accountId = createTestAccount('unread-counts');
      const thrid = 'thread-unread-counts-001';

      db.upsertThread(makeThreadInput(accountId, thrid, { isRead: false }));
      db.upsertThreadFolder(accountId, thrid, 'INBOX');

      const counts = db.getUnreadThreadCountsByFolder(accountId);
      expect(counts['INBOX']).to.be.greaterThan(0);
    });

    it('does not count a read thread in unread counts', () => {
      const db = getDatabase();
      const accountId = createTestAccount('read-counts');
      const thrid = 'thread-read-counts-001';

      db.upsertThread(makeThreadInput(accountId, thrid, { isRead: true }));
      db.upsertThreadFolder(accountId, thrid, 'INBOX');

      const counts = db.getUnreadThreadCountsByFolder(accountId);
      expect(counts['INBOX'] ?? 0).to.equal(0);
    });

    it('count drops to 0 after thread is marked read via updateThreadFlags', () => {
      const db = getDatabase();
      const accountId = createTestAccount('flag-read-toggle');
      const thrid = 'thread-flag-read-toggle-001';

      db.upsertThread(makeThreadInput(accountId, thrid, { isRead: false }));
      db.upsertThreadFolder(accountId, thrid, 'INBOX');

      // Should be unread
      expect(db.getUnreadThreadCountsByFolder(accountId)['INBOX']).to.equal(1);

      // Mark as read
      db.updateThreadFlags(accountId, thrid, { isRead: true });

      // Should be zero now
      const countAfter = db.getUnreadThreadCountsByFolder(accountId)['INBOX'] ?? 0;
      expect(countAfter).to.equal(0);
    });
  });

  // =========================================================================
  // 16. Embedding bookkeeping
  // =========================================================================

  describe('Embedding bookkeeping', () => {
    it('batchInsertVectorIndexedEmails records the given message IDs', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-batch');

      db.batchInsertVectorIndexedEmails(accountId, [
        { xGmMsgId: 'emb-msg-001', embeddingHash: 'hash-001' },
        { xGmMsgId: 'emb-msg-002', embeddingHash: 'hash-002' },
      ]);

      const indexed = db.getIndexedMsgIds(accountId);
      expect(indexed.has('emb-msg-001')).to.be.true;
      expect(indexed.has('emb-msg-002')).to.be.true;
    });

    it('countVectorIndexedEmails returns the correct count', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-count');

      db.batchInsertVectorIndexedEmails(accountId, [
        { xGmMsgId: 'emb-count-001', embeddingHash: 'h1' },
        { xGmMsgId: 'emb-count-002', embeddingHash: 'h2' },
        { xGmMsgId: 'emb-count-003', embeddingHash: 'h3' },
      ]);

      expect(db.countVectorIndexedEmails(accountId)).to.equal(3);
    });

    it('getAlreadyIndexedMsgIds returns the subset that are indexed', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-already');

      db.batchInsertVectorIndexedEmails(accountId, [
        { xGmMsgId: 'emb-already-001', embeddingHash: 'h1' },
      ]);

      const alreadyIndexed = db.getAlreadyIndexedMsgIds(accountId, [
        'emb-already-001',
        'emb-not-indexed-999',
      ]);
      expect(alreadyIndexed.has('emb-already-001')).to.be.true;
      expect(alreadyIndexed.has('emb-not-indexed-999')).to.be.false;
    });

    it('clearVectorIndexedEmailsForAccount removes all records for that account', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-clear');

      db.batchInsertVectorIndexedEmails(accountId, [
        { xGmMsgId: 'emb-clear-001', embeddingHash: 'h1' },
        { xGmMsgId: 'emb-clear-002', embeddingHash: 'h2' },
      ]);
      expect(db.countVectorIndexedEmails(accountId)).to.equal(2);

      db.clearVectorIndexedEmailsForAccount(accountId);
      expect(db.countVectorIndexedEmails(accountId)).to.equal(0);
    });

    it('upsertEmbeddingCrawlCursor stores and retrieves the UID cursor', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-cursor');

      db.upsertEmbeddingCrawlCursor(accountId, 12345);
      expect(db.getEmbeddingCrawlCursor(accountId)).to.equal(12345);
    });

    it('upsertEmbeddingCrawlCursor updates the cursor on second call', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-cursor-update');

      db.upsertEmbeddingCrawlCursor(accountId, 100);
      db.upsertEmbeddingCrawlCursor(accountId, 200);

      expect(db.getEmbeddingCrawlCursor(accountId)).to.equal(200);
    });

    it('getEmbeddingCrawlCursor returns 0 for a fresh account', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-cursor-fresh');
      expect(db.getEmbeddingCrawlCursor(accountId)).to.equal(0);
    });

    it('setEmbeddingBuildInterrupted marks account as interrupted', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-interrupted');

      db.setEmbeddingBuildInterrupted(accountId, true);

      const interrupted = db.getInterruptedEmbeddingAccounts();
      expect(interrupted).to.include(accountId);
    });

    it('setEmbeddingBuildInterrupted clears the interrupted flag', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-interrupted-clear');

      db.setEmbeddingBuildInterrupted(accountId, true);
      db.setEmbeddingBuildInterrupted(accountId, false);

      const interrupted = db.getInterruptedEmbeddingAccounts();
      expect(interrupted).to.not.include(accountId);
    });

    it('clearEmbeddingCrawlProgress removes the progress row', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-progress-clear');

      db.upsertEmbeddingCrawlCursor(accountId, 999);
      expect(db.getEmbeddingCrawlCursor(accountId)).to.equal(999);

      db.clearEmbeddingCrawlProgress(accountId);
      // After clear, cursor returns 0 (row not found)
      expect(db.getEmbeddingCrawlCursor(accountId)).to.equal(0);
    });

    it('batchInsertVectorIndexedEmails atomically persists cursorUid when provided', () => {
      const db = getDatabase();
      const accountId = createTestAccount('embedding-atomic-cursor');

      db.batchInsertVectorIndexedEmails(
        accountId,
        [{ xGmMsgId: 'emb-atomic-001', embeddingHash: 'h1' }],
        77777,
      );

      expect(db.getEmbeddingCrawlCursor(accountId)).to.equal(77777);
      expect(db.getIndexedMsgIds(accountId).has('emb-atomic-001')).to.be.true;
    });
  });

  // =========================================================================
  // 17. Search helper edge cases
  // =========================================================================

  describe('Search helper edge cases', () => {
    it('filterEmailsByMsgIds returns an empty set for an empty candidate list', () => {
      const db = getDatabase();
      const accountId = createTestAccount('filter-empty');

      const matchingIds = db.filterEmailsByMsgIds(accountId, [], {});

      expect(matchingIds).to.be.instanceOf(Set);
      expect(matchingIds.size).to.equal(0);
    });

    it('getEmailDatesByMsgIds returns an empty map for an empty input array', () => {
      const db = getDatabase();
      const accountId = createTestAccount('email-dates-empty');

      const dateMap = db.getEmailDatesByMsgIds(accountId, []);

      expect(dateMap).to.be.instanceOf(Map);
      expect(dateMap.size).to.equal(0);
    });

    it('filterEmailsByMsgIds applies folder joins, structured filters, and always excludes drafts', () => {
      const db = getDatabase();
      const accountId = createTestAccount('filter-structured');

      const matchingEmailId = 'filter-structured-match';
      const draftsOnlyEmailId = 'filter-structured-draft';
      const wrongFolderEmailId = 'filter-structured-folder';
      const wrongRecipientEmailId = 'filter-structured-recipient';
      const wrongAttachmentEmailId = 'filter-structured-attachment';
      const wrongReadStateEmailId = 'filter-structured-read';
      const wrongStarStateEmailId = 'filter-structured-star';

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: matchingEmailId,
        xGmThrid: 'thread-filter-structured-match',
        folder: 'Projects/Alpha',
        fromAddress: 'structured-sender@example.com',
        fromName: 'Structured Sender',
        toAddresses: 'structured-recipient@example.com',
        hasAttachments: false,
        isRead: false,
        isStarred: false,
        date: '2026-03-12T10:00:00.000Z',
      }));

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: draftsOnlyEmailId,
        xGmThrid: 'thread-filter-structured-draft',
        folder: '[Gmail]/Drafts',
        fromAddress: 'structured-sender@example.com',
        fromName: 'Structured Sender',
        toAddresses: 'structured-recipient@example.com',
        hasAttachments: false,
        isRead: false,
        isStarred: false,
        date: '2026-03-12T10:05:00.000Z',
      }));

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: wrongFolderEmailId,
        xGmThrid: 'thread-filter-structured-folder',
        folder: 'Projects/Beta',
        fromAddress: 'structured-sender@example.com',
        fromName: 'Structured Sender',
        toAddresses: 'structured-recipient@example.com',
        hasAttachments: false,
        isRead: false,
        isStarred: false,
        date: '2026-03-12T10:10:00.000Z',
      }));

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: wrongRecipientEmailId,
        xGmThrid: 'thread-filter-structured-recipient',
        folder: 'Projects/Alpha',
        fromAddress: 'structured-sender@example.com',
        fromName: 'Structured Sender',
        toAddresses: 'different-recipient@example.com',
        hasAttachments: false,
        isRead: false,
        isStarred: false,
        date: '2026-03-12T10:15:00.000Z',
      }));

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: wrongAttachmentEmailId,
        xGmThrid: 'thread-filter-structured-attachment',
        folder: 'Projects/Alpha',
        fromAddress: 'structured-sender@example.com',
        fromName: 'Structured Sender',
        toAddresses: 'structured-recipient@example.com',
        hasAttachments: true,
        isRead: false,
        isStarred: false,
        date: '2026-03-12T10:20:00.000Z',
      }));

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: wrongReadStateEmailId,
        xGmThrid: 'thread-filter-structured-read',
        folder: 'Projects/Alpha',
        fromAddress: 'structured-sender@example.com',
        fromName: 'Structured Sender',
        toAddresses: 'structured-recipient@example.com',
        hasAttachments: false,
        isRead: true,
        isStarred: false,
        date: '2026-03-12T10:25:00.000Z',
      }));

      db.upsertEmail(makeEmailInput(accountId, {
        xGmMsgId: wrongStarStateEmailId,
        xGmThrid: 'thread-filter-structured-star',
        folder: 'Projects/Alpha',
        fromAddress: 'structured-sender@example.com',
        fromName: 'Structured Sender',
        toAddresses: 'structured-recipient@example.com',
        hasAttachments: false,
        isRead: false,
        isStarred: true,
        date: '2026-03-12T10:30:00.000Z',
      }));

      const matchingIds = db.filterEmailsByMsgIds(
        accountId,
        [
          matchingEmailId,
          draftsOnlyEmailId,
          wrongFolderEmailId,
          wrongRecipientEmailId,
          wrongAttachmentEmailId,
          wrongReadStateEmailId,
          wrongStarStateEmailId,
        ],
        {
          dateFrom: '2026-03-12T00:00:00.000Z',
          dateTo: '2026-03-13T00:00:00.000Z',
          folder: 'Projects/Alpha',
          sender: 'structured-sender',
          recipient: 'structured-recipient',
          hasAttachment: false,
          isRead: false,
          isStarred: false,
        },
      );

      expect(Array.from(matchingIds)).to.deep.equal([matchingEmailId]);
    });

    it('getEmailDatesByMsgIds batches more than 500 ids and returns all stored dates', () => {
      const db = getDatabase();
      const accountId = createTestAccount('email-dates-batched');
      const xGmMsgIds: string[] = [];

      for (let index = 0; index < 505; index += 1) {
        const xGmMsgId = `email-dates-batch-${index}`;
        xGmMsgIds.push(xGmMsgId);

        db.upsertEmail(makeEmailInput(accountId, {
          xGmMsgId,
          xGmThrid: `email-dates-thread-${index}`,
          date: DateTime.utc(2026, 3, 12, 0, 0, 0).plus({ minutes: index }).toISO()!,
        }));
      }

      const dateMap = db.getEmailDatesByMsgIds(accountId, xGmMsgIds);

      expect(dateMap.size).to.equal(505);
      expect(dateMap.get('email-dates-batch-0')).to.equal('2026-03-12T00:00:00.000Z');
      expect(dateMap.get('email-dates-batch-504')).to.equal('2026-03-12T08:24:00.000Z');
    });

    it('handles more than 500 semantic chat candidates without error', async function () {
      this.timeout(45_000);

      const seededAccount = seedTestAccount({
        email: 'db-filter-batching@example.com',
        displayName: 'DB Filter Batching',
      });
      const db = getDatabase();
      const vectorDbService = VectorDbService.getInstance();

      expect(vectorDbService.vectorsAvailable).to.equal(true);

      await configureInboxChatModels();

      const candidateCount = 505;
      const sharedSender = 'batch-filter-sender@example.com';

      for (let index = 0; index < candidateCount; index += 1) {
        const xGmMsgId = `db-batch-msg-${index}`;
        const xGmThrid = `db-batch-thread-${index}`;

        db.upsertEmail(makeEmailInput(seededAccount.accountId, {
          xGmMsgId,
          xGmThrid,
          folder: 'INBOX',
          fromAddress: sharedSender,
          fromName: 'Batch Filter Sender',
          subject: `Batching candidate ${index}`,
          textBody: `Vector candidate body ${index}`,
          date: DateTime.utc(2026, 3, 12, 12, 0, 0).minus({ minutes: index }).toISO()!,
        }));

        vectorDbService.insertChunks({
          accountId: seededAccount.accountId,
          xGmMsgId,
          chunks: [
            {
              chunkIndex: 0,
              chunkText: `Batching vector chunk ${index}`,
              embedding: [1, 0, 0, 0],
            },
          ],
        });
      }

      ollamaServer.setChatResponse(JSON.stringify([
        { query: 'batching unrelated alpha', dateOrder: 'desc' },
        { query: 'batching unrelated beta', dateOrder: 'desc' },
        { query: 'batching unrelated gamma', dateOrder: 'desc' },
        { query: 'batching unrelated delta', dateOrder: 'desc' },
        { query: 'batching relevant variant', sender: sharedSender, dateOrder: 'desc' },
      ]));
      ollamaServer.setEmbeddings([
        [0, 1, 0, 0],
        [0, 0, 1, 0],
        [0, 0, 0, 1],
        [-1, 0, 0, 0],
        [1, 0, 0, 0],
      ]);
      ollamaServer.setChatStreamChunks(['Batched candidate search completed [1].']);

      const chatResponse = await callIpc('ai:chat', {
        question: 'Find the batched semantic candidates from this sender.',
        conversationHistory: [],
        accountId: seededAccount.accountId,
      }) as IpcResponse<{ requestId: string }>;

      expect(chatResponse.success).to.equal(true);

      const doneArgs = await waitForEvent('ai:chat:done', {
        timeout: 30_000,
        predicate: (args) => {
          const payload = args[0] as ChatDonePayload | undefined;
          return payload != null && payload.requestId === chatResponse.data!.requestId;
        },
      });
      const donePayload = doneArgs[0] as ChatDonePayload;

      expect(donePayload.success).to.equal(true);
      expect(donePayload.cancelled).to.equal(false);
    });
  });
});
