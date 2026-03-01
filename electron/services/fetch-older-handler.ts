import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { ImapService } from './imap-service';
import { formatParticipantList } from '../utils/format-participant';

const log = LoggerService.getInstance();

export interface FetchOlderResult {
  threads: Array<Record<string, unknown>>;
  hasMore: boolean;
  nextBeforeDate: string | null;
}

/**
 * Execute fetch-older (scroll-to-load) for a folder: IMAP fetch, DB upserts,
 * then return enriched threads before the cursor date.
 * Used by MailQueueService.processFetchOlder inside folder lock.
 * @throws on invalid date or IMAP/DB errors
 */
export async function executeFetchOlder(
  accountId: number,
  folderId: string,
  beforeDate: string,
  limit: number
): Promise<FetchOlderResult> {
  const db = DatabaseService.getInstance();
  const imapService = ImapService.getInstance();

  const parsedDate = new Date(beforeDate);
  if (isNaN(parsedDate.getTime())) {
    throw new Error(`Invalid beforeDate: ${beforeDate}`);
  }

  const sanitizedLimit = Math.max(1, Number(limit) || 50);

  const { emails, hasMore } = await imapService.fetchOlderEmails(
    String(accountId),
    folderId,
    parsedDate,
    sanitizedLimit
  );

  if (emails.length === 0) {
    log.info(`executeFetchOlder: no older emails found for ${folderId}`);
    return { threads: [], hasMore: false, nextBeforeDate: null };
  }

  const threadMap = new Map<string, typeof emails>();
  for (const email of emails) {
    const threadId = email.xGmThrid || email.xGmMsgId;
    if (!threadMap.has(threadId)) {
      threadMap.set(threadId, []);
    }
    threadMap.get(threadId)!.push(email);
  }

  for (const email of emails) {
    db.upsertEmail({
      accountId,
      xGmMsgId: email.xGmMsgId,
      xGmThrid: email.xGmThrid,
      folder: folderId,
      folderUid: email.uid,
      fromAddress: email.fromAddress,
      fromName: email.fromName,
      toAddresses: email.toAddresses,
      ccAddresses: email.ccAddresses,
      bccAddresses: email.bccAddresses,
      subject: email.subject,
      textBody: email.textBody,
      htmlBody: email.htmlBody,
      date: email.date,
      isRead: email.isRead,
      isStarred: email.isStarred,
      isImportant: email.isImportant,
      isDraft: email.isDraft,
      snippet: email.snippet,
      size: email.size,
      hasAttachments: email.hasAttachments,
      labels: email.labels,
      messageId: email.messageId,
    });

    if (email.fromAddress) {
      db.upsertContact(email.fromAddress, email.fromName);
    }
  }

  for (const [threadId, threadEmails] of threadMap) {
    const uniqueEmails = [...new Map(threadEmails.map((e) => [e.xGmMsgId, e])).values()];
    const latest = uniqueEmails.reduce((a, b) =>
      new Date(a.date).getTime() > new Date(b.date).getTime() ? a : b
    );
    const participants = formatParticipantList(uniqueEmails);
    const allRead = uniqueEmails.every((e) => e.isRead);
    const anyStarred = uniqueEmails.some((e) => e.isStarred);

    db.upsertThread({
      accountId,
      xGmThrid: threadId,
      subject: latest.subject,
      lastMessageDate: latest.date,
      participants,
      messageCount: uniqueEmails.length,
      snippet: latest.snippet,
      isRead: allRead,
      isStarred: anyStarred,
    });

    db.upsertThreadFolder(accountId, threadId, folderId);
  }

  let threads = db.getThreadsByFolderBeforeDate(
    accountId,
    folderId,
    beforeDate,
    sanitizedLimit
  );
  threads = attachThreadDraftStatus(db, threads, folderId);

  const oldestEmailTs = emails.reduce((minTs, email) => {
    const ts = new Date(email.date).getTime();
    if (!Number.isFinite(ts)) {
      return minTs;
    }
    return ts < minTs ? ts : minTs;
  }, Number.POSITIVE_INFINITY);

  let nextBeforeDate: string | null = null;
  if (Number.isFinite(oldestEmailTs)) {
    nextBeforeDate = new Date(oldestEmailTs).toISOString();
  }

  if (!nextBeforeDate || new Date(nextBeforeDate).getTime() >= parsedDate.getTime()) {
    const fallback = new Date(parsedDate);
    fallback.setDate(fallback.getDate() - 1);
    nextBeforeDate = fallback.toISOString();
  }

  log.info(
    `executeFetchOlder: fetched ${emails.length} emails, ${threadMap.size} threads, ` +
      `returning ${threads.length} threads, hasMore=${hasMore}, nextBeforeDate=${nextBeforeDate}`
  );

  return { threads, hasMore, nextBeforeDate };
}

function attachThreadDraftStatus(
  db: DatabaseService,
  threads: Array<Record<string, unknown>>,
  folderId: string
): Array<Record<string, unknown>> {
  const threadIds = threads
    .map((thread) => {
      const rawId = thread['id'];
      if (typeof rawId === 'number') {
        return rawId;
      }
      if (typeof rawId === 'string') {
        const parsed = Number(rawId);
        return Number.isFinite(parsed) ? parsed : null;
      }
      return null;
    })
    .filter((id): id is number => id != null && id > 0);

  if (threadIds.length === 0) {
    return threads;
  }

  const draftThreadIds = db.getThreadIdsWithDrafts(threadIds, folderId);
  if (draftThreadIds.size === 0) {
    return threads;
  }

  return threads.map((thread) => {
    const rawId = thread['id'];
    const threadId = typeof rawId === 'number' ? rawId : Number(rawId);
    if (Number.isFinite(threadId) && draftThreadIds.has(threadId)) {
      return { ...thread, hasDraft: true };
    }
    return thread;
  });
}
