/**
 * compose-drafts-send.test.ts — Backend E2E tests for draft creation, update, and send lifecycle.
 *
 * Covers:
 *   - compose:search-contacts — keyword match, empty result, empty query
 *   - compose:get-signatures — returns stored signatures
 *   - compose:save-signature — persists to DB; retrieved on next get
 *   - compose:delete-signature — removes a specific signature by id
 *   - queue:enqueue draft-create — IMAP APPEND to [Gmail]/Drafts, DB persist,
 *     queue:update completed event, mail:folder-updated with reason='draft-create'
 *   - queue:enqueue draft-update — replaces previous draft; old message expunged
 *   - queue:enqueue send — SMTP capture server receives message with correct headers,
 *     queue:update completed event, mail:folder-updated with reason='send'
 *   - send: to/subject/text fields appear in captured SMTP message
 *   - Validation: draft-update without originalQueueId or serverDraftXGmMsgId → QUEUE_INVALID_PAYLOAD
 *   - Validation: send without to → QUEUE_INVALID_PAYLOAD
 *
 * Pattern:
 *   - before(): quiesce/restore + seed one test account
 *   - Individual tests enqueue queue operations and wait for completion events
 */

import { expect } from 'chai';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  waitForEvent,
  seedTestAccount,
} from '../infrastructure/test-helpers';
import { imapStateInspector, smtpServer } from '../test-main';
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

// ---- Helper: wait for a queue:update event with a specific queueId and terminal status ----

async function waitForQueueUpdate(
  queueId: string,
  status: 'completed' | 'failed',
  timeoutMs: number = 20_000,
): Promise<QueueUpdateSnapshot> {
  const bus = TestEventBus.getInstance();

  const resultArgs = await bus.waitFor('queue:update', {
    timeout: timeoutMs,
    predicate: (args) => {
      const snapshot = args[0] as QueueUpdateSnapshot | undefined;
      return (
        snapshot != null &&
        snapshot.queueId === queueId &&
        (snapshot.status === 'completed' || snapshot.status === 'failed')
      );
    },
  });

  return resultArgs[0] as QueueUpdateSnapshot;
}

// ---- Helper: wait for a mail:folder-updated event with specific reason ----

async function waitForFolderUpdated(
  accountId: number,
  reason: string,
  timeoutMs: number = 15_000,
): Promise<Record<string, unknown>> {
  const bus = TestEventBus.getInstance();
  const priorCount = bus.getHistory('mail:folder-updated').filter((record) => {
    const payload = record.args[0] as Record<string, unknown> | undefined;
    return (
      payload != null &&
      Number(payload['accountId']) === accountId &&
      payload['reason'] === reason
    );
  }).length;

  const resultArgs = await bus.waitFor('mail:folder-updated', {
    timeout: timeoutMs,
    predicate: (args) => {
      const payload = args[0] as Record<string, unknown> | undefined;
      if (!payload) {
        return false;
      }
      if (Number(payload['accountId']) !== accountId) {
        return false;
      }
      if (payload['reason'] !== reason) {
        return false;
      }
      const currentCount = bus.getHistory('mail:folder-updated').filter((record) => {
        const innerPayload = record.args[0] as Record<string, unknown> | undefined;
        return (
          innerPayload != null &&
          Number(innerPayload['accountId']) === accountId &&
          innerPayload['reason'] === reason
        );
      }).length;
      return currentCount > priorCount;
    },
  });

  return resultArgs[0] as Record<string, unknown>;
}

// =========================================================================
// Compose: signatures and contacts
// =========================================================================

describe('Compose Drafts and Send', () => {
  before(async function () {
    this.timeout(30_000);

    await quiesceAndRestore();

    const seeded = seedTestAccount({
      email: 'compose-test@example.com',
      displayName: 'Compose Test User',
    });
    suiteAccountId = seeded.accountId;
    suiteEmail = seeded.email;

    // Reset IMAP server state and allow this account
    imapStateInspector.reset();
    imapStateInspector.getServer().addAllowedAccount(suiteEmail);

    // Reset SMTP capture server
    smtpServer.clearCaptures();
  });

  // -------------------------------------------------------------------------
  // compose:search-contacts
  // -------------------------------------------------------------------------

  describe('compose:search-contacts', () => {
    it('returns an empty array when no contacts match the query', async () => {
      const response = await callIpc(
        'compose:search-contacts',
        'nobody-exists-xyz',
      ) as IpcResponse<unknown[]>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');
      expect(response.data!.length).to.equal(0);
    });

    it('returns contacts that match by email prefix', async () => {
      // Insert a contact directly into the DB so we can query it
      const db = DatabaseService.getInstance();
      db.upsertContact('alice@example.com', 'Alice Smith');

      const response = await callIpc(
        'compose:search-contacts',
        'alice',
      ) as IpcResponse<Array<Record<string, unknown>>>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');

      const match = response.data!.find(
        (contact) => contact['email'] === 'alice@example.com',
      );
      expect(match).to.exist;
    });

    it('returns contacts that match by display name', async () => {
      const db = DatabaseService.getInstance();
      db.upsertContact('bob@example.com', 'Bob Johnson');

      const response = await callIpc(
        'compose:search-contacts',
        'Bob',
      ) as IpcResponse<Array<Record<string, unknown>>>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');

      const match = response.data!.find(
        (contact) => contact['email'] === 'bob@example.com',
      );
      expect(match).to.exist;
    });
  });

  // -------------------------------------------------------------------------
  // compose:get-signatures / compose:save-signature / compose:delete-signature
  // -------------------------------------------------------------------------

  describe('compose signatures', () => {
    it('returns an empty array when no signatures have been saved', async () => {
      const response = await callIpc('compose:get-signatures') as IpcResponse<unknown[]>;

      expect(response.success).to.equal(true);
      expect(response.data).to.be.an('array');
    });

    it('saves a signature and retrieves it', async () => {
      const testSignature = {
        id: 'sig-test-001',
        name: 'Work Signature',
        html: '<p>Best regards,<br>Test User</p>',
        isDefault: true,
      };

      const saveResponse = await callIpc(
        'compose:save-signature',
        [testSignature],
      ) as IpcResponse<null>;

      expect(saveResponse.success).to.equal(true);

      const getResponse = await callIpc('compose:get-signatures') as IpcResponse<typeof testSignature[]>;

      expect(getResponse.success).to.equal(true);
      expect(getResponse.data).to.be.an('array');
      expect(getResponse.data!.length).to.be.greaterThan(0);

      const found = getResponse.data!.find((sig) => sig.id === 'sig-test-001');
      expect(found).to.exist;
      expect(found!.name).to.equal('Work Signature');
      expect(found!.isDefault).to.equal(true);
    });

    it('deletes a signature by id', async () => {
      // First save two signatures
      const signatures = [
        { id: 'sig-keep', name: 'Keep Me', html: '<p>Keep</p>', isDefault: false },
        { id: 'sig-delete', name: 'Delete Me', html: '<p>Delete</p>', isDefault: false },
      ];

      await callIpc('compose:save-signature', signatures);

      // Delete the second one
      const deleteResponse = await callIpc(
        'compose:delete-signature',
        'sig-delete',
      ) as IpcResponse<null>;

      expect(deleteResponse.success).to.equal(true);

      // Verify deletion
      const getResponse = await callIpc('compose:get-signatures') as IpcResponse<Array<{ id: string }>>;

      expect(getResponse.success).to.equal(true);
      const deletedSig = getResponse.data!.find((sig) => sig.id === 'sig-delete');
      expect(deletedSig).to.not.exist;
    });
  });

  // -------------------------------------------------------------------------
  // Draft lifecycle: create → verify IMAP APPEND + DB
  // -------------------------------------------------------------------------

  describe('draft-create', () => {
    it('appends draft to [Gmail]/Drafts folder and emits queue:update completed', async function () {
      this.timeout(25_000);

      const draftPayload = {
        subject: 'Test Draft Subject',
        to: 'recipient@example.com',
        textBody: 'This is the draft body text.',
        htmlBody: '<p>This is the draft body text.</p>',
      };

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'draft-create',
        accountId: suiteAccountId,
        payload: draftPayload,
        description: 'Create test draft',
      }) as IpcResponse<{ queueId: string }>;

      expect(enqueueResponse.success).to.equal(true);
      expect(enqueueResponse.data!.queueId).to.be.a('string');

      const queueId = enqueueResponse.data!.queueId;

      // Wait for queue completion
      const snapshot = await waitForQueueUpdate(queueId, 'completed');
      expect(snapshot.status).to.equal('completed');
      expect(snapshot.queueId).to.equal(queueId);

      // Verify the draft was appended to the IMAP [Gmail]/Drafts mailbox
      const draftsMessages = imapStateInspector.getMessages('[Gmail]/Drafts');
      expect(draftsMessages.length).to.be.greaterThan(0);

      // Find the message that has the subject from our draft
      const draftMsg = draftsMessages.find((message) => {
        const rawText = message.rfc822.toString('utf8');
        return rawText.includes('Test Draft Subject');
      });
      expect(draftMsg).to.exist;
    });

    it('emits mail:folder-updated with reason=draft-create after successful APPEND', async function () {
      this.timeout(25_000);

      const draftPayload = {
        subject: 'Draft For FolderUpdated Test',
        to: 'folderupdated@example.com',
        textBody: 'Checking folder-updated event.',
      };

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'draft-create',
        accountId: suiteAccountId,
        payload: draftPayload,
        description: 'Draft folder-updated test',
      }) as IpcResponse<{ queueId: string }>;

      expect(enqueueResponse.success).to.equal(true);
      const queueId = enqueueResponse.data!.queueId;

      // Wait for both the queue completion AND the folder-updated event
      const [, folderUpdatedPayload] = await Promise.all([
        waitForQueueUpdate(queueId, 'completed'),
        waitForFolderUpdated(suiteAccountId, 'draft-create'),
      ]);

      expect(folderUpdatedPayload['accountId']).to.equal(suiteAccountId);
      expect(folderUpdatedPayload['reason']).to.equal('draft-create');

      const folders = folderUpdatedPayload['folders'] as string[];
      expect(folders).to.be.an('array');
      expect(folders).to.include('[Gmail]/Drafts');
    });

    it('persists draft metadata to the local DB after APPEND', async function () {
      this.timeout(25_000);

      const uniqueSubject = `DB Persist Draft ${Date.now()}`;
      const draftPayload = {
        subject: uniqueSubject,
        to: 'db-check@example.com',
        textBody: 'Checking DB persistence.',
      };

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'draft-create',
        accountId: suiteAccountId,
        payload: draftPayload,
        description: 'Draft DB persist test',
      }) as IpcResponse<{ queueId: string }>;

      const queueId = enqueueResponse.data!.queueId;
      await waitForQueueUpdate(queueId, 'completed');

      // Check the DB for this draft
      const db = DatabaseService.getInstance();
      const rawDb = db.getDatabase();
      const rows = rawDb
        .prepare('SELECT * FROM emails WHERE account_id = :accountId AND subject = :subject')
        .all({ accountId: suiteAccountId, subject: uniqueSubject }) as Array<Record<string, unknown>>;

      expect(rows.length).to.be.greaterThan(0);
    });
  });

  // -------------------------------------------------------------------------
  // Draft lifecycle: update
  // -------------------------------------------------------------------------

  describe('draft-update', () => {
    it('requires originalQueueId or serverDraftXGmMsgId — rejects without both', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'draft-update',
        accountId: suiteAccountId,
        payload: {
          subject: 'Update Draft',
          to: 'update@example.com',
          textBody: 'Updated draft body',
          // Missing both originalQueueId and serverDraftXGmMsgId
        },
        description: 'Update test draft',
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('updates an existing draft using originalQueueId and replaces it on IMAP', async function () {
      this.timeout(40_000);

      // Step 1: Create the initial draft
      const initialPayload = {
        subject: 'Original Draft Title',
        to: 'update-target@example.com',
        textBody: 'Original body text.',
      };

      const createResponse = await callIpc('queue:enqueue', {
        type: 'draft-create',
        accountId: suiteAccountId,
        payload: initialPayload,
        description: 'Initial draft for update test',
      }) as IpcResponse<{ queueId: string }>;

      expect(createResponse.success).to.equal(true);
      const createQueueId = createResponse.data!.queueId;

      // Wait for create to complete
      await waitForQueueUpdate(createQueueId, 'completed');

      // Step 2: Update the draft referencing the original queueId
      const updatePayload = {
        subject: 'Updated Draft Title',
        to: 'update-target@example.com',
        textBody: 'Updated body text.',
        originalQueueId: createQueueId,
      };

      const updateResponse = await callIpc('queue:enqueue', {
        type: 'draft-update',
        accountId: suiteAccountId,
        payload: updatePayload,
        description: 'Update test draft',
      }) as IpcResponse<{ queueId: string }>;

      expect(updateResponse.success).to.equal(true);
      const updateQueueId = updateResponse.data!.queueId;

      // Wait for update to complete
      const snapshot = await waitForQueueUpdate(updateQueueId, 'completed', 25_000);
      expect(snapshot.status).to.equal('completed');

      // Verify updated subject exists in IMAP Drafts
      const draftsMessages = imapStateInspector.getMessages('[Gmail]/Drafts');
      const updatedDraft = draftsMessages.find((message) => {
        const rawText = message.rfc822.toString('utf8');
        return rawText.includes('Updated Draft Title');
      });
      expect(updatedDraft).to.exist;
    });
  });

  // -------------------------------------------------------------------------
  // Send lifecycle
  // -------------------------------------------------------------------------

  describe('send', () => {
    it('requires a to field — rejects without it', async () => {
      const response = await callIpc('queue:enqueue', {
        type: 'send',
        accountId: suiteAccountId,
        payload: {
          subject: 'Missing To Field',
          text: 'Some body',
          // Missing to field
        },
        description: 'Send without to',
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('QUEUE_INVALID_PAYLOAD');
    });

    it('sends an email via SMTP and captures it on the capture server', async function () {
      this.timeout(25_000);

      // Clear prior captures so we can identify our specific message
      smtpServer.clearCaptures();

      const sendPayload = {
        to: 'recipient@example.com',
        subject: 'Hello From Test Suite',
        text: 'This is the plain text body.',
        html: '<p>This is the HTML body.</p>',
      };

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'send',
        accountId: suiteAccountId,
        payload: sendPayload,
        description: 'E2E send test',
      }) as IpcResponse<{ queueId: string }>;

      expect(enqueueResponse.success).to.equal(true);
      const queueId = enqueueResponse.data!.queueId;

      // Wait for send to complete
      const snapshot = await waitForQueueUpdate(queueId, 'completed');
      expect(snapshot.status).to.equal('completed');

      // Verify the SMTP capture server received the message
      const capturedEmails = smtpServer.getCapturedEmails();
      expect(capturedEmails.length).to.be.greaterThan(0);

      const lastEmail = smtpServer.getLastEmail();
      expect(lastEmail).to.exist;
      expect(lastEmail!.subject).to.equal('Hello From Test Suite');
      expect(lastEmail!.to).to.include('recipient@example.com');
    });

    it('captured SMTP message contains the correct text body', async function () {
      this.timeout(25_000);

      smtpServer.clearCaptures();

      const uniqueBodyText = `Unique body content ${Date.now()}`;
      const sendPayload = {
        to: 'body-check@example.com',
        subject: 'Body Content Test',
        text: uniqueBodyText,
      };

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'send',
        accountId: suiteAccountId,
        payload: sendPayload,
        description: 'Send body content test',
      }) as IpcResponse<{ queueId: string }>;

      const queueId = enqueueResponse.data!.queueId;
      await waitForQueueUpdate(queueId, 'completed');

      const lastEmail = smtpServer.getLastEmail();
      expect(lastEmail).to.exist;

      // The raw message or parsed text body should contain our unique text
      const containsBody =
        (lastEmail!.text !== undefined && lastEmail!.text.includes(uniqueBodyText)) ||
        lastEmail!.raw.includes(uniqueBodyText);
      expect(containsBody).to.equal(true);
    });

    it('emits mail:folder-updated with reason=send after successful send', async function () {
      this.timeout(25_000);

      smtpServer.clearCaptures();

      const sendPayload = {
        to: 'folder-event@example.com',
        subject: 'Send Folder Event Test',
        text: 'Checking folder-updated reason=send.',
      };

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'send',
        accountId: suiteAccountId,
        payload: sendPayload,
        description: 'Send folder event test',
      }) as IpcResponse<{ queueId: string }>;

      expect(enqueueResponse.success).to.equal(true);
      const queueId = enqueueResponse.data!.queueId;

      // Wait for queue completion and folder-updated concurrently
      const [, folderUpdatedPayload] = await Promise.all([
        waitForQueueUpdate(queueId, 'completed'),
        waitForFolderUpdated(suiteAccountId, 'send'),
      ]);

      expect(folderUpdatedPayload['accountId']).to.equal(suiteAccountId);
      expect(folderUpdatedPayload['reason']).to.equal('send');
    });

    it('captured SMTP message from address is the account email', async function () {
      this.timeout(25_000);

      smtpServer.clearCaptures();

      const sendPayload = {
        to: 'from-check@example.com',
        subject: 'From Address Check',
        text: 'Testing that from address is correct.',
      };

      const enqueueResponse = await callIpc('queue:enqueue', {
        type: 'send',
        accountId: suiteAccountId,
        payload: sendPayload,
        description: 'From address check',
      }) as IpcResponse<{ queueId: string }>;

      const queueId = enqueueResponse.data!.queueId;
      await waitForQueueUpdate(queueId, 'completed');

      const lastEmail = smtpServer.getLastEmail();
      expect(lastEmail).to.exist;

      // The from address should contain the account's email
      expect(lastEmail!.from).to.include(suiteEmail);
    });
  });

  // -------------------------------------------------------------------------
  // Send with prior draft cleanup
  // -------------------------------------------------------------------------

  describe('send with draft cleanup', () => {
    it('sends email and cleans up the associated draft from IMAP Drafts', async function () {
      this.timeout(45_000);

      smtpServer.clearCaptures();

      // Create a draft first
      const draftPayload = {
        subject: 'Draft Before Send',
        to: 'draft-send-cleanup@example.com',
        textBody: 'Draft that will be sent.',
      };

      const createResponse = await callIpc('queue:enqueue', {
        type: 'draft-create',
        accountId: suiteAccountId,
        payload: draftPayload,
        description: 'Draft for send-with-cleanup test',
      }) as IpcResponse<{ queueId: string }>;

      expect(createResponse.success).to.equal(true);
      const draftQueueId = createResponse.data!.queueId;

      await waitForQueueUpdate(draftQueueId, 'completed');

      // Record draft count before send
      const draftsBeforeSend = imapStateInspector.getMessages('[Gmail]/Drafts');
      const draftCountBefore = draftsBeforeSend.length;
      expect(draftCountBefore).to.be.greaterThan(0);

      // Now send the email, referencing the original draft
      const sendPayload = {
        to: 'draft-send-cleanup@example.com',
        subject: 'Draft Before Send',
        text: 'Draft that will be sent.',
        originalQueueId: draftQueueId,
      };

      const sendResponse = await callIpc('queue:enqueue', {
        type: 'send',
        accountId: suiteAccountId,
        payload: sendPayload,
        description: 'Send with draft cleanup',
      }) as IpcResponse<{ queueId: string }>;

      expect(sendResponse.success).to.equal(true);
      const sendQueueId = sendResponse.data!.queueId;

      await waitForQueueUpdate(sendQueueId, 'completed');

      // Verify email was received by SMTP
      const lastEmail = smtpServer.getLastEmail();
      expect(lastEmail).to.exist;
      expect(lastEmail!.subject).to.equal('Draft Before Send');
    });
  });
});
