import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { ImapService } from './imap-service';
import { ALL_MAIL_PATH } from './sync-service';
import type { ImapFlow } from 'imapflow';

const log = LoggerService.getInstance();

/** A minimal descriptor of an email that needs its body fetched. */
interface EmailBodyDescriptor {
  accountId: number;
  xGmMsgId: string;
  xGmThrid: string;
}

/** Summary counts returned by fetchAndStoreBodies. */
interface BodyFetchSummary {
  fetched: number;
  skipped: number;
  failed: number;
}

/**
 * BodyPrefetchService — proactively fetches and caches email bodies in the local
 * SQLite database so that when a user opens a thread, the body is already available.
 *
 * This service does NOT use FolderLockManager. It relies on ImapService methods
 * (resolveUidsByXGmMsgId, fetchMessageByUid) which handle their own ImapFlow
 * mailbox locks internally.
 */
export class BodyPrefetchService {
  private static instance: BodyPrefetchService;

  private constructor() {}

  static getInstance(): BodyPrefetchService {
    if (!BodyPrefetchService.instance) {
      BodyPrefetchService.instance = new BodyPrefetchService();
    }
    return BodyPrefetchService.instance;
  }

  /**
   * Query the DB for emails that have missing bodies for a given account.
   *
   * @param accountId    The account to query.
   * @param limit        Max number of emails to return (default 50).
   * @param sinceMinutes If provided, narrows to emails updated in the last N minutes (IDLE path).
   *                     If omitted, uses a 7-day window on both date and updated_at (periodic path).
   */
  getEmailsNeedingBodies(
    accountId: number,
    limit: number = 50,
    sinceMinutes?: number,
  ): EmailBodyDescriptor[] {
    const db = DatabaseService.getInstance();
    return db.getEmailsNeedingBodies(accountId, limit, sinceMinutes);
  }

  /**
   * Fetch bodies from IMAP for a batch of emails and store them in the DB.
   *
   * Flow:
   * 1. Resolve all xGmMsgIds to UIDs in [Gmail]/All Mail (single mailbox lock session).
   *    - If resolution throws (network error): logs warn, returns early.
   *    - If individual UIDs are missing from the map: logs debug, skips those emails.
   * 2. For each resolved UID, fetch the full message via fetchMessageByUid.
   *    - If fetch returns null or throws: logs warn, skips, continues.
   * 3. Update only text_body and html_body in the DB (body-only update with idempotent WHERE guard).
   * 4. Persist attachment metadata if present (independent of body update; failures are warnings).
   * 5. Returns a summary count for logging.
   *
   * @param accountId      The account whose emails are being fetched.
   * @param emails         The batch of email descriptors to fetch bodies for.
   * @param dedicatedClient  Optional pre-existing ImapFlow client (owned by BodyFetchQueueService).
   *                         When provided, uses resolveUidsByXGmMsgIdWithClient and
   *                         fetchMessageByUidWithClient instead of the shared-pool methods.
   *                         When omitted, falls back to the shared-pool methods (existing behaviour).
   */
  async fetchAndStoreBodies(
    accountId: number,
    emails: Array<{ xGmMsgId: string; xGmThrid: string }>,
    dedicatedClient?: ImapFlow,
  ): Promise<BodyFetchSummary> {
    const summary: BodyFetchSummary = { fetched: 0, skipped: 0, failed: 0 };

    if (emails.length === 0) {
      return summary;
    }

    const db = DatabaseService.getInstance();
    const imapService = ImapService.getInstance();
    const accountIdStr = String(accountId);

    // Step 1: Resolve all xGmMsgIds → UIDs in [Gmail]/All Mail.
    const xGmMsgIds = emails.map((email) => email.xGmMsgId);
    let uidMap: Map<string, number>;
    try {
      if (dedicatedClient) {
        uidMap = await imapService.resolveUidsByXGmMsgIdWithClient(dedicatedClient, ALL_MAIL_PATH, xGmMsgIds);
      } else {
        uidMap = await imapService.resolveUidsByXGmMsgId(accountIdStr, ALL_MAIL_PATH, xGmMsgIds);
      }
    } catch (resolveErr) {
      log.warn(
        `[BodyPrefetch] Failed to resolve UIDs for account ${accountId} in ${ALL_MAIL_PATH}: ${
          resolveErr instanceof Error ? resolveErr.message : String(resolveErr)
        }`,
      );
      summary.skipped = emails.length;
      return summary;
    }

    // Step 2: Fetch bodies for each resolved UID.
    for (const email of emails) {
      const uid = uidMap.get(email.xGmMsgId);
      if (uid === undefined) {
        log.debug(
          `[BodyPrefetch] UID not found in All Mail for xGmMsgId=${email.xGmMsgId} (account=${accountId}), skipping`,
        );
        summary.skipped++;
        continue;
      }

      let fetched: Awaited<ReturnType<typeof imapService.fetchMessageByUid>>;
      try {
        if (dedicatedClient) {
          fetched = await imapService.fetchMessageByUidWithClient(dedicatedClient, ALL_MAIL_PATH, uid);
        } else {
          fetched = await imapService.fetchMessageByUid(accountIdStr, ALL_MAIL_PATH, uid);
        }
      } catch (fetchErr) {
        log.warn(
          `[BodyPrefetch] Failed to fetch body for xGmMsgId=${email.xGmMsgId} uid=${uid} (account=${accountId}): ${
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
          }`,
        );
        summary.failed++;
        continue;
      }

      if (fetched === null) {
        log.warn(
          `[BodyPrefetch] fetchMessageByUid returned null for xGmMsgId=${email.xGmMsgId} uid=${uid} (account=${accountId}), skipping`,
        );
        summary.skipped++;
        continue;
      }

      // Only update if there is something to store.
      if (!fetched.textBody && !fetched.htmlBody) {
        log.debug(
          `[BodyPrefetch] Empty body returned for xGmMsgId=${email.xGmMsgId} (account=${accountId}), skipping`,
        );
        summary.skipped++;
        continue;
      }

      // Step 3: Update only the body fields.
      db.updateEmailBodyOnly(accountId, email.xGmMsgId, fetched.textBody, fetched.htmlBody);
      summary.fetched++;

      // Step 4: Persist attachment metadata (independent — failures don't affect body update).
      if (fetched.attachments && fetched.attachments.length > 0) {
        try {
          db.upsertAttachmentsForEmail(accountId, email.xGmMsgId, fetched.attachments);
        } catch (attErr) {
          log.warn(
            `[BodyPrefetch] Failed to persist attachment metadata for xGmMsgId=${email.xGmMsgId} (account=${accountId}): ${
              attErr instanceof Error ? attErr.message : String(attErr)
            }`,
          );
        }
      }
    }

    log.info(
      `[BodyPrefetch] Body fetch complete for account ${accountId}: fetched=${summary.fetched}, skipped=${summary.skipped}, failed=${summary.failed}`,
    );

    return summary;
  }
}
