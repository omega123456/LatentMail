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
import { quiesceAndRestore } from '../infrastructure/suite-lifecycle';
import {
  callIpc,
  waitForEvent,
  seedTestAccount,
  triggerSyncAndWait,
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

  it('returns MAIL_THREAD_NOT_FOUND from DB for a non-existent thread', async () => {
    const response = await callIpc(
      'mail:get-thread-from-db',
      String(suiteAccountId),
      'does-not-exist-anywhere',
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
});
