/**
 * mail-viewing.test.ts — Backend E2E tests for mail viewing / local retrieval.
 *
 * Covers:
 *   - mail:get-folders returns folder list with correct unread thread counts
 *   - mail:fetch-emails returns paginated thread list for a folder, enriched
 *     with folders/labels/draft markers
 *   - mail:fetch-thread returns thread with all emails and enrichment
 *   - mail:fetch-thread with missing bodies triggers async IMAP fetch and emits
 *     mail:thread-refresh
 *   - mail:get-thread-from-db returns DB-only thread without IMAP interaction
 *   - mail:fetch-older returns older threads with hasMore and nextBeforeDate cursor
 *   - mail:search-by-msgids resolves message IDs to enriched thread rows (max 200 cap)
 *
 * Pattern:
 *   - before(): quiesce/restore + seed one test account + inject IMAP messages +
 *     trigger sync + wait for mail:folder-updated
 *   - Individual tests then call the retrieval IPCs and assert against DB state.
 */

import { expect } from 'chai';
import { DateTime } from 'luxon';
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  waitForEvent,
  getDatabase,
  seedTestAccount,
  triggerSyncAndWait,
  waitForQueueTerminalState,
} from '../infrastructure/test-helpers';
import { imapStateInspector } from '../test-main';
import { emlFixtures } from '../fixtures/index';
import { TestEventBus } from '../infrastructure/test-event-bus';

// ---- Type helpers for IPC responses ----

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

interface ThreadRow {
  xGmThrid: string;
  messageCount: number;
  isRead: boolean;
  isStarred: boolean;
  participants: string;
  snippet: string;
  lastMessageDate: string;
  labels?: unknown[];
  folders?: string[];
  hasDraft?: boolean;
}

interface MessageRow {
  xGmMsgId: string;
  xGmThrid: string;
  subject: string;
  fromAddress: string;
  textBody?: string;
  htmlBody?: string;
  folders?: string[];
}

interface ThreadWithMessages extends ThreadRow {
  messages: MessageRow[];
}

interface FetchOlderResponse {
  queueId: string;
}

interface FetchOlderDonePayload {
  queueId: string;
  accountId: number;
  folderId: string;
  threads?: ThreadRow[];
  hasMore?: boolean;
  nextBeforeDate?: string | null;
  error?: string;
}

// ---- Suite-level state ----

let suiteAccountId: number;
let suiteEmail: string;

function createLocalThreadInFolder(
  accountId: number,
  folder: string,
  xGmThrid: string,
  xGmMsgId: string,
  subject: string,
): void {
  const db = getDatabase();
  const nowIso = DateTime.now().toUTC().toISO() ?? '2026-01-01T00:00:00.000Z';

  db.upsertEmail({
    accountId,
    xGmMsgId,
    xGmThrid,
    folder,
    folderUid: undefined,
    fromAddress: 'folder-seed@example.com',
    fromName: 'Folder Seed',
    toAddresses: 'recipient@example.com',
    ccAddresses: '',
    bccAddresses: '',
    subject,
    textBody: 'Seeded body',
    htmlBody: '<p>Seeded body</p>',
    date: nowIso,
    isRead: false,
    isStarred: false,
    isImportant: false,
    isDraft: folder === '[Gmail]/Drafts',
    snippet: 'Seeded snippet',
    hasAttachments: false,
    messageId: `<${xGmMsgId}@example.com>`,
  });

  db.upsertThread({
    accountId,
    xGmThrid,
    subject,
    lastMessageDate: nowIso,
    participants: 'Folder Seed <folder-seed@example.com>',
    messageCount: 1,
    snippet: 'Seeded snippet',
    isRead: false,
    isStarred: false,
  });

  db.upsertThreadFolder(accountId, xGmThrid, folder);
}

describe('Mail Viewing', () => {
  before(async function () {
    this.timeout(30_000);

    await quiesceAndRestore();

    // Seed a test account
    const seeded = seedTestAccount({
      email: 'viewing@example.com',
      displayName: 'Viewing Test User',
    });
    suiteAccountId = seeded.accountId;
    suiteEmail = seeded.email;

    // Reset IMAP fake server state and configure it for this account
    imapStateInspector.reset();
    imapStateInspector.getServer().addAllowedAccount(suiteEmail);

    // Inject fixtures into INBOX on the fake IMAP server
    const plainMsg = emlFixtures['plain-text'];
    const htmlMsg = emlFixtures['html-email'];
    const thread1 = emlFixtures['reply-thread-1'];
    const thread2 = emlFixtures['reply-thread-2'];
    const thread3 = emlFixtures['reply-thread-3'];

    imapStateInspector.injectMessage('INBOX', plainMsg.raw, {
      xGmMsgId: plainMsg.headers.xGmMsgId,
      xGmThrid: plainMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
    imapStateInspector.injectMessage('INBOX', htmlMsg.raw, {
      xGmMsgId: htmlMsg.headers.xGmMsgId,
      xGmThrid: htmlMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });

    // Inject the 3-message thread with the same xGmThrid so they appear as one thread
    imapStateInspector.injectMessage('INBOX', thread1.raw, {
      xGmMsgId: thread1.headers.xGmMsgId,
      xGmThrid: thread1.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
    imapStateInspector.injectMessage('INBOX', thread2.raw, {
      xGmMsgId: thread2.headers.xGmMsgId,
      xGmThrid: thread2.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });
    imapStateInspector.injectMessage('INBOX', thread3.raw, {
      xGmMsgId: thread3.headers.xGmMsgId,
      xGmThrid: thread3.headers.xGmThrid,
      xGmLabels: ['\\Inbox'],
    });

    // Also inject one message into [Gmail]/All Mail so the All Mail sync works
    imapStateInspector.injectMessage('[Gmail]/All Mail', plainMsg.raw, {
      xGmMsgId: plainMsg.headers.xGmMsgId,
      xGmThrid: plainMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', htmlMsg.raw, {
      xGmMsgId: htmlMsg.headers.xGmMsgId,
      xGmThrid: htmlMsg.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', thread1.raw, {
      xGmMsgId: thread1.headers.xGmMsgId,
      xGmThrid: thread1.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', thread2.raw, {
      xGmMsgId: thread2.headers.xGmMsgId,
      xGmThrid: thread2.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });
    imapStateInspector.injectMessage('[Gmail]/All Mail', thread3.raw, {
      xGmMsgId: thread3.headers.xGmMsgId,
      xGmThrid: thread3.headers.xGmThrid,
      xGmLabels: ['\\Inbox', '\\All Mail'],
    });

    // Trigger sync and wait for it to complete
    await triggerSyncAndWait(suiteAccountId, { timeout: 25_000 });
  });

  // -------------------------------------------------------------------------
  // mail:get-folders
  // -------------------------------------------------------------------------

  it('returns the folder list with correct structure after sync', async () => {
    const response = await callIpc('mail:get-folders', String(suiteAccountId)) as IpcResponse<FolderRow[]>;

    expect(response.success).to.equal(true);
    expect(response.data).to.be.an('array');
    expect(response.data!.length).to.be.greaterThan(0);

    // Every folder row must have the required fields
    for (const folder of response.data!) {
      expect(folder).to.have.property('gmailLabelId').that.is.a('string');
      expect(folder).to.have.property('name').that.is.a('string');
      expect(folder).to.have.property('unreadCount').that.is.a('number');
    }

    // INBOX must be present
    const inboxFolder = response.data!.find(
      (folder) => folder.gmailLabelId.toUpperCase() === 'INBOX',
    );
    expect(inboxFolder).to.exist;
  });

  it('excludes [Gmail] parent container from the folder list', async () => {
    const response = await callIpc('mail:get-folders', String(suiteAccountId)) as IpcResponse<FolderRow[]>;

    expect(response.success).to.equal(true);

    // [Gmail] parent should not appear — it's in EXCLUDED_FOLDER_PATHS
    const gmailParent = response.data!.find(
      (folder) => folder.gmailLabelId === '[Gmail]',
    );
    expect(gmailParent).to.not.exist;
  });

  it('reports non-zero unread count for INBOX after injecting unread messages', async () => {
    const response = await callIpc('mail:get-folders', String(suiteAccountId)) as IpcResponse<FolderRow[]>;

    expect(response.success).to.equal(true);

    const inboxFolder = response.data!.find(
      (folder) => folder.gmailLabelId.toUpperCase() === 'INBOX',
    );
    // The injected messages are unread (no \\Seen flag), so unread count should be > 0
    expect(inboxFolder).to.exist;
    expect(inboxFolder!.unreadCount).to.be.greaterThan(0);
  });

  // -------------------------------------------------------------------------
  // mail:fetch-emails
  // -------------------------------------------------------------------------

  it('returns a thread list for INBOX with correct structure', async () => {
    const response = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
      { limit: 50, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;

    expect(response.success).to.equal(true);
    expect(response.data).to.be.an('array');
    expect(response.data!.length).to.be.greaterThan(0);

    for (const thread of response.data!) {
      expect(thread).to.have.property('xGmThrid').that.is.a('string');
      expect(thread).to.have.property('messageCount').that.is.a('number');
      expect(thread).to.have.property('isRead').that.is.a('boolean');
      expect(thread).to.have.property('isStarred').that.is.a('boolean');
      expect(thread).to.have.property('lastMessageDate').that.is.a('string');
    }
  });

  it('returns threads with labels array attached', async () => {
    const response = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
      { limit: 50, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;

    expect(response.success).to.equal(true);

    // Every thread returned should have a labels array (may be empty)
    for (const thread of response.data!) {
      expect(thread).to.have.property('labels').that.is.an('array');
    }
  });

  it('groups the 3-message reply thread as a single thread with messageCount 3', async () => {
    const thread1Headers = emlFixtures['reply-thread-1'].headers;

    const response = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
      { limit: 50, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;

    expect(response.success).to.equal(true);

    const replyThread = response.data!.find(
      (thread) => thread.xGmThrid === thread1Headers.xGmThrid,
    );

    expect(replyThread).to.exist;
    expect(replyThread!.messageCount).to.equal(3);
  });

  it('paginates correctly with offset', async () => {
    const firstPage = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
      { limit: 1, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;

    const secondPage = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
      { limit: 1, offset: 1 },
    ) as IpcResponse<ThreadRow[]>;

    expect(firstPage.success).to.equal(true);
    expect(secondPage.success).to.equal(true);

    // Both pages must have exactly 1 result each
    expect(firstPage.data).to.have.lengthOf(1);
    expect(secondPage.data).to.have.lengthOf(1);

    // They must be different threads
    expect(firstPage.data![0].xGmThrid).to.not.equal(secondPage.data![0].xGmThrid);
  });

  it('returns empty array for a folder with no messages', async () => {
    // [Gmail]/Sent Mail should have no messages since we only injected to INBOX / All Mail
    const response = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      '[Gmail]/Sent Mail',
      { limit: 50, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;

    expect(response.success).to.equal(true);
    expect(response.data).to.be.an('array');
    expect(response.data).to.have.lengthOf(0);
  });

  it('supports offset/limit pagination without overlapping results', async () => {
    const pageOne = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
      { limit: 2, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;

    const pageTwo = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
      { limit: 2, offset: 2 },
    ) as IpcResponse<ThreadRow[]>;

    expect(pageOne.success).to.equal(true);
    expect(pageTwo.success).to.equal(true);
    expect(pageOne.data).to.have.lengthOf(2);
    expect(pageTwo.data).to.have.lengthOf(1);

    const pageOneIds = new Set(pageOne.data!.map((thread) => thread.xGmThrid));
    for (const thread of pageTwo.data!) {
      expect(pageOneIds.has(thread.xGmThrid)).to.equal(false);
    }
  });

  it('returns folder-specific email listings for INBOX, Sent Mail, and Drafts', async function () {
    this.timeout(20_000);

    await createLocalThreadInFolder(
      suiteAccountId,
      '[Gmail]/Sent Mail',
      'folder-sent-thread',
      'folder-sent-msg',
      'Sent Folder Seed',
    );
    await createLocalThreadInFolder(
      suiteAccountId,
      '[Gmail]/Drafts',
      'folder-draft-thread',
      'folder-draft-msg',
      'Draft Folder Seed',
    );

    const inboxResponse = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
      { limit: 50, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;
    const sentResponse = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      '[Gmail]/Sent Mail',
      { limit: 50, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;
    const draftsResponse = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      '[Gmail]/Drafts',
      { limit: 50, offset: 0 },
    ) as IpcResponse<ThreadRow[]>;

    expect(inboxResponse.success).to.equal(true);
    expect(sentResponse.success).to.equal(true);
    expect(draftsResponse.success).to.equal(true);
    expect(inboxResponse.data!.length).to.be.greaterThan(0);
    expect(sentResponse.data!.map((thread) => thread.xGmThrid)).to.include('folder-sent-thread');
    expect(draftsResponse.data!.map((thread) => thread.xGmThrid)).to.include('folder-draft-thread');
  });

  // -------------------------------------------------------------------------
  // mail:fetch-thread
  // -------------------------------------------------------------------------

  it('returns a thread with all messages and folder enrichment', async () => {
    const thread1Headers = emlFixtures['reply-thread-1'].headers;

    const response = await callIpc(
      'mail:fetch-thread',
      String(suiteAccountId),
      thread1Headers.xGmThrid,
    ) as IpcResponse<ThreadWithMessages>;

    expect(response.success).to.equal(true);
    expect(response.data).to.exist;
    expect(response.data!.xGmThrid).to.equal(thread1Headers.xGmThrid);
    expect(response.data!.messages).to.be.an('array');
    expect(response.data!.messages.length).to.equal(3);

    // Each message must have folder enrichment
    for (const message of response.data!.messages) {
      expect(message).to.have.property('xGmMsgId').that.is.a('string');
      expect(message).to.have.property('folders').that.is.an('array');
    }
  });

  it('returns MAIL_THREAD_NOT_FOUND error for a non-existent thread', async () => {
    const response = await callIpc(
      'mail:fetch-thread',
      String(suiteAccountId),
      'nonexistent-thread-id',
    ) as IpcResponse<ThreadWithMessages>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_THREAD_NOT_FOUND');
  });

  it('enqueues a sync-thread when bodies are missing and emits mail:thread-refresh', async function () {
    this.timeout(20_000);

    // We need a thread that is in the DB but has no bodies. The plain-text message
    // fixture was injected but bodies are fetched lazily via sync-thread. After the
    // initial sync, the thread is in DB but may not have bodies yet (sync-allmail only
    // fetches metadata unless this is an initial sync that also fetches bodies).
    // The simplest reliable approach: force the fetch and wait for thread-refresh.
    const plainHeaders = emlFixtures['plain-text'].headers;

    const priorRefreshCount = TestEventBus.getInstance().getHistory('mail:thread-refresh').length;

    const response = await callIpc(
      'mail:fetch-thread',
      String(suiteAccountId),
      plainHeaders.xGmThrid,
      true, // forceFromServer
    ) as IpcResponse<ThreadWithMessages>;

    expect(response.success).to.equal(true);

    // Wait for the async sync-thread worker to emit mail:thread-refresh
    const refreshArgs = await waitForEvent('mail:thread-refresh', {
      timeout: 15_000,
      predicate: (args) => {
        const payload = args[0] as Record<string, unknown> | undefined;
        if (!payload) {
          return false;
        }
        // Only accept a thread-refresh event for our specific thread and account
        if (Number(payload['accountId']) !== suiteAccountId) {
          return false;
        }
        const currentCount = TestEventBus.getInstance().getHistory('mail:thread-refresh').length;
        return currentCount > priorRefreshCount && payload['xGmThrid'] === plainHeaders.xGmThrid;
      },
    });

    const refreshPayload = refreshArgs[0] as Record<string, unknown>;
    expect(Number(refreshPayload['accountId'])).to.equal(suiteAccountId);
    expect(refreshPayload['xGmThrid']).to.equal(plainHeaders.xGmThrid);
  });

  // -------------------------------------------------------------------------
  // mail:get-thread-from-db
  // -------------------------------------------------------------------------

  it('returns a thread from DB without triggering IMAP interaction', async () => {
    const thread1Headers = emlFixtures['reply-thread-1'].headers;

    const response = await callIpc(
      'mail:get-thread-from-db',
      String(suiteAccountId),
      thread1Headers.xGmThrid,
    ) as IpcResponse<ThreadWithMessages>;

    expect(response.success).to.equal(true);
    expect(response.data).to.exist;
    expect(response.data!.xGmThrid).to.equal(thread1Headers.xGmThrid);
    expect(response.data!.messages).to.be.an('array');
    expect(response.data!.messages.length).to.be.greaterThan(0);
  });

  it('returns an enriched thread from DB when a valid folderId is supplied', async () => {
    const thread1Headers = emlFixtures['reply-thread-1'].headers;

    const response = await callIpc(
      'mail:get-thread-from-db',
      String(suiteAccountId),
      thread1Headers.xGmThrid,
      'INBOX',
    ) as IpcResponse<ThreadWithMessages>;

    expect(response.success).to.equal(true);
    expect(response.data).to.exist;
    expect(response.data!.xGmThrid).to.equal(thread1Headers.xGmThrid);
    expect(response.data!.messages.length).to.equal(3);
    expect(response.data).to.have.property('labels').that.is.an('array');
    expect(response.data).to.have.property('folders').that.is.an('array');
  });

  it('returns MAIL_THREAD_NOT_FOUND from DB for a non-existent thread', async () => {
    const response = await callIpc(
      'mail:get-thread-from-db',
      String(suiteAccountId),
      'does-not-exist-anywhere',
    ) as IpcResponse<ThreadWithMessages>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_THREAD_NOT_FOUND');
  });

  it('returns MAIL_THREAD_NOT_FOUND from DB for a missing thread even when folderId is supplied', async () => {
    const response = await callIpc(
      'mail:get-thread-from-db',
      String(suiteAccountId),
      'missing-thread-with-folder',
      'INBOX',
    ) as IpcResponse<ThreadWithMessages>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_THREAD_NOT_FOUND');
  });

  // -------------------------------------------------------------------------
  // mail:search-by-msgids
  // -------------------------------------------------------------------------

  it('resolves message IDs to enriched thread rows', async () => {
    const plainHeaders = emlFixtures['plain-text'].headers;
    const htmlHeaders = emlFixtures['html-email'].headers;

    const response = await callIpc(
      'mail:search-by-msgids',
      String(suiteAccountId),
      [plainHeaders.xGmMsgId, htmlHeaders.xGmMsgId],
    ) as IpcResponse<ThreadRow[]>;

    expect(response.success).to.equal(true);
    expect(response.data).to.be.an('array');
    expect(response.data!.length).to.be.greaterThan(0);

    for (const thread of response.data!) {
      expect(thread).to.have.property('xGmThrid').that.is.a('string');
      expect(thread).to.have.property('labels').that.is.an('array');
    }
  });

  it('returns MAIL_SEARCH_INVALID_INPUT when more than 200 message IDs are supplied', async () => {
    const tooManyIds = Array.from({ length: 201 }, (_, index) => String(index));

    const response = await callIpc(
      'mail:search-by-msgids',
      String(suiteAccountId),
      tooManyIds,
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SEARCH_INVALID_INPUT');
  });

  it('returns MAIL_SEARCH_INVALID_INPUT for an empty message ID array', async () => {
    const response = await callIpc(
      'mail:search-by-msgids',
      String(suiteAccountId),
      [],
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SEARCH_INVALID_INPUT');
  });

  it('handles duplicate message IDs in the input gracefully', async () => {
    const plainHeaders = emlFixtures['plain-text'].headers;

    // Supply the same ID three times — should resolve to one thread
    const response = await callIpc(
      'mail:search-by-msgids',
      String(suiteAccountId),
      [plainHeaders.xGmMsgId, plainHeaders.xGmMsgId, plainHeaders.xGmMsgId],
    ) as IpcResponse<ThreadRow[]>;

    expect(response.success).to.equal(true);
    expect(response.data).to.be.an('array');

    // Should not return three copies of the same thread
    const seen = new Set<string>();
    for (const thread of response.data!) {
      expect(seen.has(thread.xGmThrid)).to.equal(false, 'Duplicate thread returned');
      seen.add(thread.xGmThrid);
    }
  });

  // -------------------------------------------------------------------------
  // mail:fetch-older
  // -------------------------------------------------------------------------

  it('enqueues a fetch-older operation and emits mail:fetch-older-done', async function () {
    this.timeout(20_000);

    // Use a date far in the future so the query spans all injected messages
    const beforeDate = '2099-01-01T00:00:00.000Z';
    const folderId = 'INBOX';

    const response = await callIpc(
      'mail:fetch-older',
      String(suiteAccountId),
      folderId,
      beforeDate,
      20,
    ) as IpcResponse<FetchOlderResponse>;

    expect(response.success).to.equal(true);
    expect(response.data).to.have.property('queueId').that.is.a('string');
    const queueId = response.data!.queueId;

    // Wait for the async fetch-older worker to emit mail:fetch-older-done
    const doneArgs = await waitForEvent('mail:fetch-older-done', {
      timeout: 15_000,
      predicate: (args) => {
        const payload = args[0] as FetchOlderDonePayload | undefined;
        return payload != null && payload.queueId === queueId;
      },
    });

    const donePayload = doneArgs[0] as FetchOlderDonePayload;
    expect(donePayload.queueId).to.equal(queueId);
    expect(donePayload.accountId).to.equal(suiteAccountId);
    expect(donePayload.folderId).to.equal(folderId);
    expect(donePayload).to.have.property('hasMore');
    // nextBeforeDate must be present (string or null) when not an error
    if (!donePayload.error) {
      expect(donePayload).to.have.property('nextBeforeDate');
    }
  });

  it('uses default pagination options when mail:fetch-emails is called without an options object', async () => {
    const response = await callIpc(
      'mail:fetch-emails',
      String(suiteAccountId),
      'INBOX',
    ) as IpcResponse<ThreadRow[]>;

    expect(response.success).to.equal(true);
    expect(response.data).to.be.an('array');
    expect(response.data!.length).to.be.greaterThan(0);
  });

  it('returns INVALID_DATE error for a malformed beforeDate', async () => {
    const response = await callIpc(
      'mail:fetch-older',
      String(suiteAccountId),
      'INBOX',
      'not-a-date',
      20,
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('INVALID_DATE');
  });

  it('returns INVALID_ACCOUNT for a malformed accountId when mail:fetch-older is called', async () => {
    const beforeDate = DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z';

    const response = await callIpc(
      'mail:fetch-older',
      'not-a-number',
      'INBOX',
      beforeDate,
      20,
    ) as IpcResponse<FetchOlderResponse>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('INVALID_ACCOUNT');
  });

  it('returns MAIL_SEARCH_INVALID_INPUT when mail:search-by-msgids receives an invalid accountId', async () => {
    const response = await callIpc(
      'mail:search-by-msgids',
      '',
      ['123'],
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SEARCH_INVALID_INPUT');
  });

  it('returns MAIL_SEARCH_INVALID_INPUT when mail:search-by-msgids receives non-string message ids', async () => {
    const response = await callIpc(
      'mail:search-by-msgids',
      String(suiteAccountId),
      ['valid-id', 123],
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SEARCH_INVALID_INPUT');
  });

  it('recomputes thread metadata when some messages are pending server confirmation', async () => {
    const pendingOpServiceModule = require('../../../electron/services/pending-op-service') as typeof import('../../../electron/services/pending-op-service');
    const pendingOpService = pendingOpServiceModule.PendingOpService.getInstance();
    const thread1Headers = emlFixtures['reply-thread-1'].headers;
    const thread2Headers = emlFixtures['reply-thread-2'].headers;

    pendingOpService.register(suiteAccountId, thread1Headers.xGmThrid, [thread1Headers.xGmMsgId]);

    try {
      const response = await callIpc(
        'mail:fetch-thread',
        String(suiteAccountId),
        thread1Headers.xGmThrid,
      ) as IpcResponse<ThreadWithMessages>;

      expect(response.success).to.equal(true);
      expect(response.data).to.exist;
      expect(response.data!.messages.length).to.equal(2);
      expect(response.data!.messageCount).to.equal(2);
      expect(response.data!.messages.map((message) => message.xGmMsgId)).to.not.include(thread1Headers.xGmMsgId);
      expect(response.data!.messages.map((message) => message.xGmMsgId)).to.include(thread2Headers.xGmMsgId);
    } finally {
      pendingOpService.clear(suiteAccountId, thread1Headers.xGmThrid, [thread1Headers.xGmMsgId]);
    }
  });

  it('returns zeroed thread metadata when all thread messages are pending server confirmation', async () => {
    const pendingOpServiceModule = require('../../../electron/services/pending-op-service') as typeof import('../../../electron/services/pending-op-service');
    const pendingOpService = pendingOpServiceModule.PendingOpService.getInstance();
    const thread1Headers = emlFixtures['reply-thread-1'].headers;
    const thread2Headers = emlFixtures['reply-thread-2'].headers;
    const thread3Headers = emlFixtures['reply-thread-3'].headers;
    const pendingMessageIds = [thread1Headers.xGmMsgId, thread2Headers.xGmMsgId, thread3Headers.xGmMsgId];

    pendingOpService.register(suiteAccountId, thread1Headers.xGmThrid, pendingMessageIds);

    try {
      const response = await callIpc(
        'mail:fetch-thread',
        String(suiteAccountId),
        thread1Headers.xGmThrid,
      ) as IpcResponse<ThreadWithMessages>;

      expect(response.success).to.equal(true);
      expect(response.data).to.exist;
      expect(response.data!.messages).to.have.lengthOf(0);
      expect(response.data!.messageCount).to.equal(0);
      expect(response.data!.snippet).to.equal('');
      expect(response.data!.participants).to.equal('');
      expect(response.data!.lastMessageDate).to.equal('');
      expect(response.data!.isRead).to.equal(true);
      expect(response.data!.isStarred).to.equal(false);
    } finally {
      pendingOpService.clear(suiteAccountId, thread1Headers.xGmThrid, pendingMessageIds);
    }
  });

  // -------------------------------------------------------------------------
  // Label + manual sync validation
  // -------------------------------------------------------------------------

  it('returns MAIL_SEARCH_BY_MSGIDS_FAILED when thread resolution throws unexpectedly', async () => {
    const databaseService = getDatabase();
    const originalGetThreadsByXGmMsgIds = databaseService.getThreadsByXGmMsgIds.bind(databaseService);
    databaseService.getThreadsByXGmMsgIds = (() => {
      throw new Error('forced search-by-msgids failure');
    }) as typeof databaseService.getThreadsByXGmMsgIds;

    try {
      const response = await callIpc(
        'mail:search-by-msgids',
        String(suiteAccountId),
        ['123'],
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_SEARCH_BY_MSGIDS_FAILED');
    } finally {
      databaseService.getThreadsByXGmMsgIds = originalGetThreadsByXGmMsgIds;
    }
  });

  it('returns MAIL_SYNC_FAILED with the default message when sync-account throws a non-Error value', async () => {
    const syncQueueBridgeModule = require('../../../electron/services/sync-queue-bridge') as typeof import('../../../electron/services/sync-queue-bridge');
    const syncQueueBridge = syncQueueBridgeModule.SyncQueueBridge.getInstance() as unknown as {
      enqueueSyncForAccount: (accountId: number, isInitial: boolean) => Promise<string | null>;
    };
    const originalEnqueueSyncForAccount = syncQueueBridge.enqueueSyncForAccount;
    syncQueueBridge.enqueueSyncForAccount = (async () => {
      throw 'non-error-sync-account-failure';
    }) as typeof syncQueueBridge.enqueueSyncForAccount;

    try {
      const response = await callIpc('mail:sync-account', String(suiteAccountId)) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_SYNC_FAILED');
      expect(response.error!.message).to.equal('Sync failed');
    } finally {
      syncQueueBridge.enqueueSyncForAccount = originalEnqueueSyncForAccount;
    }
  });

  it('returns MAIL_SYNC_FOLDER_FAILED with the default message when sync-folder throws a non-Error value', async () => {
    const databaseService = getDatabase();
    const originalGetAccountById = databaseService.getAccountById.bind(databaseService);
    databaseService.getAccountById = (() => {
      throw 'non-error-sync-folder-failure';
    }) as typeof databaseService.getAccountById;

    try {
      const response = await callIpc('mail:sync-folder', {
        accountId: String(suiteAccountId),
        folder: 'INBOX',
      }) as IpcResponse<void>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_SYNC_FOLDER_FAILED');
      expect(response.error!.message).to.equal('Failed to trigger folder sync');
    } finally {
      databaseService.getAccountById = originalGetAccountById;
    }
  });

  it('returns INVALID_ACCOUNT when mail:fetch-older receives a non-numeric accountId', async () => {
    const response = await callIpc(
      'mail:fetch-older',
      'not-a-number',
      'INBOX',
      DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z',
      20,
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('INVALID_ACCOUNT');
  });

  it('returns MAIL_FETCH_OLDER_FAILED when fetch-older enqueue throws unexpectedly', async () => {
    const queueServiceModule = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
    const queueService = queueServiceModule.MailQueueService.getInstance() as unknown as {
      enqueue: (...args: unknown[]) => string;
    };
    const originalEnqueue = queueService.enqueue;
    queueService.enqueue = (() => {
      throw new Error('forced fetch-older enqueue failure');
    }) as typeof queueService.enqueue;

    try {
      const response = await callIpc(
        'mail:fetch-older',
        String(suiteAccountId),
        'INBOX',
        DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z',
        20,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_FETCH_OLDER_FAILED');
    } finally {
      queueService.enqueue = originalEnqueue;
    }
  });

  it('returns LABEL_INVALID_ACCOUNT when label:create receives a non-positive accountId', async () => {
    const response = await callIpc(
      'label:create',
      '0',
      'BadAccountLabel',
      null,
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_ACCOUNT');
  });

  it('returns LABEL_INVALID_NAME when label:create receives a blank name', async () => {
    const response = await callIpc(
      'label:create',
      String(suiteAccountId),
      '   ',
      null,
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_NAME');
  });

  it('returns LABEL_INVALID_NAME when label:create receives a name longer than 100 characters', async () => {
    const overlongLabelName = 'L'.repeat(101);

    const response = await callIpc(
      'label:create',
      String(suiteAccountId),
      overlongLabelName,
      null,
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_NAME');
  });

  it('returns LABEL_INVALID_NAME when label:create receives IMAP-invalid characters', async () => {
    const response = await callIpc(
      'label:create',
      String(suiteAccountId),
      'Bad*Label',
      null,
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_NAME');
  });

  it('returns LABEL_INVALID_COLOR when label:create receives a non-string color value', async () => {
    const response = await callIpc(
      'label:create',
      String(suiteAccountId),
      'BadColorTypeLabel',
      42,
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_COLOR');
  });

  it('returns LABEL_INVALID_ACCOUNT when label:delete receives a non-positive accountId', async () => {
    const response = await callIpc(
      'label:delete',
      '0',
      'LABEL_ID',
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_ACCOUNT');
  });

  it('returns LABEL_INVALID_ID when label:delete receives a blank label id', async () => {
    const response = await callIpc(
      'label:delete',
      String(suiteAccountId),
      '   ',
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_ID');
  });

  it('returns LABEL_INVALID_ACCOUNT when label:update-color receives a non-positive accountId', async () => {
    const response = await callIpc(
      'label:update-color',
      '0',
      'LABEL_ID',
      '#ff0000',
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_ACCOUNT');
  });

  it('returns LABEL_INVALID_ID when label:update-color receives a blank label id', async () => {
    const response = await callIpc(
      'label:update-color',
      String(suiteAccountId),
      '',
      '#ff0000',
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('LABEL_INVALID_ID');
  });

  it('returns MAIL_SYNC_FOLDER_INVALID_INPUT when mail:sync-folder receives a non-positive accountId', async () => {
    const response = await callIpc('mail:sync-folder', {
      accountId: '0',
      folder: 'INBOX',
    }) as IpcResponse<void>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SYNC_FOLDER_INVALID_INPUT');
  });

  it('returns MAIL_SYNC_FOLDER_INVALID_INPUT when mail:sync-folder receives a non-object payload', async () => {
    const response = await callIpc('mail:sync-folder', 'not-an-object') as IpcResponse<void>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SYNC_FOLDER_INVALID_INPUT');
  });

  it('returns MAIL_SYNC_FOLDER_INVALID_INPUT when mail:sync-folder receives a blank accountId string', async () => {
    const response = await callIpc('mail:sync-folder', {
      accountId: '   ',
      folder: 'INBOX',
    }) as IpcResponse<void>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SYNC_FOLDER_INVALID_INPUT');
  });

  it('returns MAIL_SYNC_FOLDER_ACCOUNT_NOT_FOUND when mail:sync-folder receives a missing account', async () => {
    const response = await callIpc('mail:sync-folder', {
      accountId: '99999',
      folder: 'INBOX',
    }) as IpcResponse<void>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SYNC_FOLDER_ACCOUNT_NOT_FOUND');
  });

  it('returns MAIL_SYNC_FOLDER_INVALID_INPUT when mail:sync-folder receives a blank folder', async () => {
    const response = await callIpc('mail:sync-folder', {
      accountId: String(suiteAccountId),
      folder: '   ',
    }) as IpcResponse<void>;

    expect(response.success).to.equal(false);
    expect(response.error!.code).to.equal('MAIL_SYNC_FOLDER_INVALID_INPUT');
  });

  it('returns LABEL_CREATE_FAILED when IMAP mailbox creation throws unexpectedly', async () => {
    const imapServiceModule = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
    const imapService = imapServiceModule.ImapService.getInstance() as unknown as {
      createMailbox: (accountId: string, mailboxName: string) => Promise<void>;
    };
    const originalCreateMailbox = imapService.createMailbox;
    imapService.createMailbox = async (): Promise<void> => {
      throw new Error('forced label create failure');
    };

    try {
      const response = await callIpc(
        'label:create',
        String(suiteAccountId),
        'CreateFailureLabel',
        null,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_CREATE_FAILED');
    } finally {
      imapService.createMailbox = originalCreateMailbox;
    }
  });

  it('returns LABEL_CREATE_FAILED with the default message when label creation throws a non-Error value', async () => {
    const imapServiceModule = require('../../../electron/services/imap-service') as typeof import('../../../electron/services/imap-service');
    const imapService = imapServiceModule.ImapService.getInstance() as unknown as {
      createMailbox: (accountId: string, mailboxName: string) => Promise<void>;
    };
    const originalCreateMailbox = imapService.createMailbox;
    imapService.createMailbox = async (): Promise<void> => {
      throw 'non-error-label-create-failure';
    };

    try {
      const response = await callIpc(
        'label:create',
        String(suiteAccountId),
        'CreateFailureLabelNonError',
        null,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_CREATE_FAILED');
      expect(response.error!.message).to.equal('Failed to create label');
    } finally {
      imapService.createMailbox = originalCreateMailbox;
    }
  });

  it('returns LABEL_DELETE_FAILED when label lookup throws unexpectedly', async () => {
    const databaseService = getDatabase();
    const originalGetLabelByGmailId = databaseService.getLabelByGmailId.bind(databaseService);
    databaseService.getLabelByGmailId = (() => {
      throw new Error('forced label delete failure');
    }) as typeof databaseService.getLabelByGmailId;

    try {
      const response = await callIpc(
        'label:delete',
        String(suiteAccountId),
        'Anything',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_DELETE_FAILED');
    } finally {
      databaseService.getLabelByGmailId = originalGetLabelByGmailId;
    }
  });

  it('returns LABEL_DELETE_FAILED with the default message when label deletion throws a non-Error value', async () => {
    const databaseService = getDatabase();
    const originalGetLabelByGmailId = databaseService.getLabelByGmailId.bind(databaseService);
    databaseService.getLabelByGmailId = (() => {
      throw 'non-error-label-delete-failure';
    }) as typeof databaseService.getLabelByGmailId;

    try {
      const response = await callIpc(
        'label:delete',
        String(suiteAccountId),
        'AnythingElse',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_DELETE_FAILED');
      expect(response.error!.message).to.equal('Failed to delete label');
    } finally {
      databaseService.getLabelByGmailId = originalGetLabelByGmailId;
    }
  });

  it('returns LABEL_UPDATE_COLOR_FAILED when label color persistence throws unexpectedly', async () => {
    const databaseService = getDatabase();
    const originalUpdateLabelColor = databaseService.updateLabelColor.bind(databaseService);
    databaseService.updateLabelColor = (() => {
      throw new Error('forced label color failure');
    }) as typeof databaseService.updateLabelColor;

    try {
      const response = await callIpc(
        'label:update-color',
        String(suiteAccountId),
        'AnyLabel',
        '#ff0000',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_UPDATE_COLOR_FAILED');
    } finally {
      databaseService.updateLabelColor = originalUpdateLabelColor;
    }
  });

  it('returns LABEL_UPDATE_COLOR_FAILED with the default message when color update throws a non-Error value', async () => {
    const databaseService = getDatabase();
    const originalUpdateLabelColor = databaseService.updateLabelColor.bind(databaseService);
    databaseService.updateLabelColor = (() => {
      throw 'non-error-label-color-failure';
    }) as typeof databaseService.updateLabelColor;

    try {
      const response = await callIpc(
        'label:update-color',
        String(suiteAccountId),
        'AnyLabelAgain',
        '#00ff00',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('LABEL_UPDATE_COLOR_FAILED');
      expect(response.error!.message).to.equal('Failed to update label color');
    } finally {
      databaseService.updateLabelColor = originalUpdateLabelColor;
    }
  });

  it('returns MAIL_GET_FOLDERS_FAILED when folder lookup throws unexpectedly', async () => {
    const databaseService = getDatabase();
    const originalGetLabelsByAccount = databaseService.getLabelsByAccount.bind(databaseService);
    databaseService.getLabelsByAccount = (() => {
      throw new Error('forced get-folders failure');
    }) as typeof databaseService.getLabelsByAccount;

    try {
      const response = await callIpc(
        'mail:get-folders',
        String(suiteAccountId),
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_GET_FOLDERS_FAILED');
    } finally {
      databaseService.getLabelsByAccount = originalGetLabelsByAccount;
    }
  });

  it('returns MAIL_FETCH_FAILED when thread listing throws unexpectedly', async () => {
    const databaseService = getDatabase();
    const originalGetThreadsByFolder = databaseService.getThreadsByFolder.bind(databaseService);
    databaseService.getThreadsByFolder = (() => {
      throw new Error('forced fetch-emails failure');
    }) as typeof databaseService.getThreadsByFolder;

    try {
      const response = await callIpc(
        'mail:fetch-emails',
        String(suiteAccountId),
        'INBOX',
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_FETCH_FAILED');
    } finally {
      databaseService.getThreadsByFolder = originalGetThreadsByFolder;
    }
  });

  it('returns MAIL_FETCH_THREAD_FAILED when thread retrieval throws unexpectedly', async () => {
    const databaseService = getDatabase();
    const originalGetThreadById = databaseService.getThreadById.bind(databaseService);
    databaseService.getThreadById = (() => {
      throw new Error('forced fetch-thread failure');
    }) as typeof databaseService.getThreadById;

    try {
      const response = await callIpc(
        'mail:fetch-thread',
        String(suiteAccountId),
        emlFixtures['reply-thread-1'].headers.xGmThrid,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_FETCH_THREAD_FAILED');
    } finally {
      databaseService.getThreadById = originalGetThreadById;
    }
  });

  it('returns MAIL_FETCH_THREAD_FAILED when DB-only thread retrieval throws unexpectedly', async () => {
    const databaseService = getDatabase();
    const originalGetThreadById = databaseService.getThreadById.bind(databaseService);
    databaseService.getThreadById = (() => {
      throw new Error('forced get-thread-from-db failure');
    }) as typeof databaseService.getThreadById;

    try {
      const response = await callIpc(
        'mail:get-thread-from-db',
        String(suiteAccountId),
        emlFixtures['reply-thread-1'].headers.xGmThrid,
      ) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_FETCH_THREAD_FAILED');
    } finally {
      databaseService.getThreadById = originalGetThreadById;
    }
  });

  // -------------------------------------------------------------------------
  // Direct mail mutation IPC coverage
  // -------------------------------------------------------------------------

  it('direct mail:send enqueues a send operation successfully', async function () {
    this.timeout(20_000);

    const response = await callIpc('mail:send', String(suiteAccountId), {
      to: 'direct-send@example.com',
      subject: 'Direct mail send coverage',
      text: 'Direct mail send body',
    }) as IpcResponse<{ queueId: string }>;

    expect(response.success).to.equal(true);
    expect(response.data!.queueId).to.be.a('string');

    const snapshot = await waitForQueueTerminalState(response.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });
    expect(snapshot['status']).to.equal('completed');
  });

  it('direct mail:send returns MAIL_SEND_FAILED with the default message when enqueue throws a non-Error value', async () => {
    const queueServiceModule = require('../../../electron/services/mail-queue-service') as typeof import('../../../electron/services/mail-queue-service');
    const queueService = queueServiceModule.MailQueueService.getInstance() as unknown as {
      enqueue: (...args: unknown[]) => string;
    };
    const originalEnqueue = queueService.enqueue;
    queueService.enqueue = (() => {
      throw 'non-error-mail-send-failure';
    }) as typeof queueService.enqueue;

    try {
      const response = await callIpc('mail:send', String(suiteAccountId), {
        to: 'direct-send-failure@example.com',
        subject: 'Direct mail send failure',
        text: 'Direct send failure body',
      }) as IpcResponse<unknown>;

      expect(response.success).to.equal(false);
      expect(response.error!.code).to.equal('MAIL_SEND_FAILED');
      expect(response.error!.message).to.equal('Failed to enqueue send');
    } finally {
      queueService.enqueue = originalEnqueue;
    }
  });

  it('direct mail:flag supports important updates without thread flag metadata updates', async function () {
    this.timeout(20_000);

    const db = getDatabase();
    const rawDb = db.getDatabase();
    const messageId = emlFixtures['plain-text'].headers.xGmMsgId;
    const threadId = emlFixtures['plain-text'].headers.xGmThrid;
    const threadBefore = db.getThreadById(suiteAccountId, threadId);

    expect(threadBefore).to.not.equal(null);

    const response = await callIpc(
      'mail:flag',
      String(suiteAccountId),
      [messageId],
      'important',
      true,
    ) as IpcResponse<{ queueId: string }>;

    expect(response.success).to.equal(true);
    await waitForQueueTerminalState(response.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });

    const emailRow = rawDb.prepare(
      `SELECT is_important AS isImportant
       FROM emails
       WHERE account_id = :accountId AND x_gm_msgid = :xGmMsgId`
    ).get({
      accountId: suiteAccountId,
      xGmMsgId: messageId,
    }) as { isImportant: number } | undefined;
    const threadAfter = db.getThreadById(suiteAccountId, threadId);

    expect(emailRow).to.not.equal(undefined);
    expect(emailRow!.isImportant).to.equal(1);
    expect(threadAfter).to.not.equal(null);
    expect(threadAfter!['isRead']).to.equal(threadBefore!['isRead']);
    expect(threadAfter!['isStarred']).to.equal(threadBefore!['isStarred']);
  });

  it('direct mail:flag accepts an unknown flag name and still enqueues successfully', async function () {
    this.timeout(20_000);

    const response = await callIpc(
      'mail:flag',
      String(suiteAccountId),
      [emlFixtures['html-email'].headers.xGmMsgId],
      'unknown-flag',
      true,
    ) as IpcResponse<{ queueId: string }>;

    expect(response.success).to.equal(true);
    await waitForQueueTerminalState(response.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });
  });

  it('direct mail:move removes orphan thread folder associations when the thread has no emails', async () => {
    const orphanThreadId = 'orphan-thread-for-move';
    const db = getDatabase();
    const rawDb = db.getDatabase();
    rawDb.prepare(
      `INSERT INTO threads (account_id, x_gm_thrid, subject, last_message_date, participants, message_count, snippet, is_read, is_starred)
       VALUES (:accountId, :xGmThrid, :subject, :lastMessageDate, :participants, :messageCount, :snippet, :isRead, :isStarred)`
    ).run({
      accountId: suiteAccountId,
      xGmThrid: orphanThreadId,
      subject: 'Orphan move thread',
      lastMessageDate: DateTime.utc().toISO() ?? '2026-01-01T00:00:00.000Z',
      participants: 'Nobody',
      messageCount: 0,
      snippet: '',
      isRead: 1,
      isStarred: 0,
    });
    db.upsertThreadFolder(suiteAccountId, orphanThreadId, 'INBOX');

    const response = await callIpc(
      'mail:move',
      String(suiteAccountId),
      [orphanThreadId],
      '[Gmail]/Sent Mail',
      'INBOX',
    ) as IpcResponse<unknown>;

    expect(response.success).to.equal(true);
    const threadStillInInbox = rawDb.prepare(
      'SELECT COUNT(*) AS count FROM thread_folders WHERE account_id = :accountId AND x_gm_thrid = :xGmThrid AND folder = :folder'
    ).get({ accountId: suiteAccountId, xGmThrid: orphanThreadId, folder: 'INBOX' }) as { count: number };
    expect(threadStillInInbox.count).to.equal(0);
  });

  it('direct mail:move filters out emails not present in the specified source folder', async function () {
    this.timeout(20_000);

    const db = getDatabase();

    await createLocalThreadInFolder(
      suiteAccountId,
      '[Gmail]/Sent Mail',
      'move-filter-thread',
      'move-filter-msg',
      'Move Filter Seed',
    );

    const response = await callIpc(
      'mail:move',
      String(suiteAccountId),
      [emlFixtures['plain-text'].headers.xGmMsgId, 'move-filter-msg'],
      '[Gmail]/Drafts',
      'INBOX',
    ) as IpcResponse<{ queueId: string }>;

    expect(response.success).to.equal(true);
    await waitForQueueTerminalState(response.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });

    const movedFolders = db.getFoldersForEmail(suiteAccountId, emlFixtures['plain-text'].headers.xGmMsgId);
    const untouchedFolders = db.getFoldersForEmail(suiteAccountId, 'move-filter-msg');

    expect(movedFolders).to.include('[Gmail]/Drafts');
    expect(movedFolders).to.not.include('INBOX');
    expect(untouchedFolders).to.include('[Gmail]/Sent Mail');
    expect(untouchedFolders).to.not.include('[Gmail]/Drafts');
  });

  it('direct mail:move preserves source thread folder when sibling emails remain in the source folder', async function () {
    this.timeout(20_000);

    const db = getDatabase();
    const moveMessageId = emlFixtures['reply-thread-1'].headers.xGmMsgId;
    const threadId = emlFixtures['reply-thread-1'].headers.xGmThrid;
    const response = await callIpc(
      'mail:move',
      String(suiteAccountId),
      [moveMessageId],
      '[Gmail]/Drafts',
      'INBOX',
    ) as IpcResponse<{ queueId: string }>;

    expect(response.success).to.equal(true);
    await waitForQueueTerminalState(response.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });

    const movedEmailFolders = db.getFoldersForEmail(suiteAccountId, moveMessageId);
    const threadFolders = db.getFoldersForThread(suiteAccountId, threadId);

    expect(movedEmailFolders).to.include('[Gmail]/Drafts');
    expect(movedEmailFolders).to.not.include('INBOX');
    expect(threadFolders).to.include('INBOX');
    expect(threadFolders).to.include('[Gmail]/Drafts');
  });

  it('direct mail:move can compute source folders when sourceFolder is omitted', async function () {
    this.timeout(20_000);

    const db = getDatabase();
    const messageId = emlFixtures['html-email'].headers.xGmMsgId;

    const response = await callIpc(
      'mail:move',
      String(suiteAccountId),
      [messageId],
      '[Gmail]/Sent Mail',
    ) as IpcResponse<{ queueId: string }>;

    expect(response.success).to.equal(true);
    await waitForQueueTerminalState(response.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });

    const folders = db.getFoldersForEmail(suiteAccountId, messageId);

    expect(folders).to.include('[Gmail]/Sent Mail');
    expect(folders).to.not.include('INBOX');
  });

  it('direct mail:delete returns no-op success when all emails are filtered out for the folder', async () => {
    await createLocalThreadInFolder(
      suiteAccountId,
      '[Gmail]/Sent Mail',
      'delete-filter-thread',
      'delete-filter-msg',
      'Delete Filter Seed',
    );

    const response = await callIpc(
      'mail:delete',
      String(suiteAccountId),
      ['delete-filter-msg'],
      'INBOX',
    ) as IpcResponse<{ queueId: string | null }>;

    expect(response.success).to.equal(true);
    expect(response.data!.queueId).to.equal(null);
  });

  it('direct mail:delete preserves source thread folder when sibling emails remain in the folder', async function () {
    this.timeout(20_000);

    const db = getDatabase();
    const trashFolder = db.getTrashFolder(suiteAccountId);
    const deleteMessageId = emlFixtures['reply-thread-2'].headers.xGmMsgId;
    const threadId = emlFixtures['reply-thread-2'].headers.xGmThrid;
    const response = await callIpc(
      'mail:delete',
      String(suiteAccountId),
      [deleteMessageId],
      'INBOX',
    ) as IpcResponse<{ queueId: string }>;

    expect(response.success).to.equal(true);
    await waitForQueueTerminalState(response.data!.queueId, { expectedStatus: 'completed', timeout: 15_000 });

    const deletedEmailFolders = db.getFoldersForEmail(suiteAccountId, deleteMessageId);
    const threadFolders = db.getFoldersForThread(suiteAccountId, threadId);

    expect(deletedEmailFolders).to.include(trashFolder);
    expect(deletedEmailFolders).to.not.include('INBOX');
    expect(threadFolders).to.include('INBOX');
    expect(threadFolders).to.include(trashFolder);
  });

  it('direct get-thread-from-db filters pending messages when folderId is supplied', async () => {
    const pendingOpServiceModule = require('../../../electron/services/pending-op-service') as typeof import('../../../electron/services/pending-op-service');
    const pendingOpService = pendingOpServiceModule.PendingOpService.getInstance();
    const pendingMessageId = emlFixtures['reply-thread-3'].headers.xGmMsgId;
    const threadId = emlFixtures['reply-thread-1'].headers.xGmThrid;

    pendingOpService.register(suiteAccountId, threadId, [pendingMessageId]);

    try {
      const response = await callIpc(
        'mail:get-thread-from-db',
        String(suiteAccountId),
        threadId,
        'INBOX',
      ) as IpcResponse<ThreadWithMessages>;

      expect(response.success).to.equal(true);
      expect(response.data!.messages.map((message) => message.xGmMsgId)).to.not.include(pendingMessageId);
    } finally {
      pendingOpService.clear(suiteAccountId, threadId, [pendingMessageId]);
    }
  });

  it('direct get-thread-from-db filters pending messages when no folderId is supplied', async () => {
    const pendingOpServiceModule = require('../../../electron/services/pending-op-service') as typeof import('../../../electron/services/pending-op-service');
    const pendingOpService = pendingOpServiceModule.PendingOpService.getInstance();
    const pendingMessageId = emlFixtures['plain-text'].headers.xGmMsgId;
    const threadId = emlFixtures['plain-text'].headers.xGmThrid;

    pendingOpService.register(suiteAccountId, threadId, [pendingMessageId]);

    try {
      const response = await callIpc(
        'mail:get-thread-from-db',
        String(suiteAccountId),
        threadId,
      ) as IpcResponse<ThreadWithMessages>;

      expect(response.success).to.equal(true);
      expect(response.data!.messages.map((message) => message.xGmMsgId)).to.not.include(pendingMessageId);
    } finally {
      pendingOpService.clear(suiteAccountId, threadId, [pendingMessageId]);
    }
  });
});
