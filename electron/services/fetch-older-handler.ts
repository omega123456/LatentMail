import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { ImapService } from './imap-service';
import { ALL_MAIL_PATH } from './sync-service';
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

  const parsedDt = DateTime.fromISO(beforeDate);
  if (!parsedDt.isValid) {
    throw new Error(`Invalid beforeDate: ${beforeDate}`);
  }
  const parsedDate = parsedDt.toJSDate();

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
      DateTime.fromISO(a.date).toMillis() > DateTime.fromISO(b.date).toMillis() ? a : b
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

  // Resolve All Mail UIDs for the upserted emails (skip if fetched from All Mail itself,
  // as those already have UIDs from the upsert above).
  if (folderId !== ALL_MAIL_PATH) {
    try {
      const xGmMsgIds = emails.map((email) => email.xGmMsgId).filter(Boolean);
      if (xGmMsgIds.length > 0) {
        const uidMap = await imapService.resolveUidsByXGmMsgIdBatch(String(accountId), ALL_MAIL_PATH, xGmMsgIds);
        db.writeAllMailFolderUids(accountId, uidMap);
      }
    } catch (allMailUidErr) {
      log.warn(`executeFetchOlder: failed to resolve All Mail UIDs for ${folderId} (continuing):`, allMailUidErr);
    }
  }

  let threads = db.getThreadsByFolderBeforeDate(
    accountId,
    folderId,
    beforeDate,
    sanitizedLimit
  );
  threads = attachThreadDraftStatus(db, threads, folderId, accountId);

  const oldestEmailTs = emails.reduce((minTs, email) => {
    const dt = DateTime.fromISO(email.date);
    if (!dt.isValid) {
      return minTs;
    }
    const ts = dt.toMillis();
    return ts < minTs ? ts : minTs;
  }, Number.POSITIVE_INFINITY);

  let nextBeforeDate: string | null = null;
  if (Number.isFinite(oldestEmailTs)) {
    nextBeforeDate = DateTime.fromMillis(oldestEmailTs).toUTC().toISO();
  }

  if (!nextBeforeDate || DateTime.fromISO(nextBeforeDate).toMillis() >= parsedDt.toMillis()) {
    nextBeforeDate = parsedDt.minus({ days: 1 }).toUTC().toISO();
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
  folderId: string,
  accountId: number
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

  const draftThreadIds = db.getThreadIdsWithDrafts(accountId, threadIds, folderId);
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
