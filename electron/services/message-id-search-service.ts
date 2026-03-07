/**
 * MessageIdSearchService — resolves a single email by its x_gm_msgid.
 *
 * Used by the AI chat panel's "source card" navigation feature. When the user
 * clicks a source citation, this service finds the referenced email either from
 * the local DB cache or via an IMAP fallback, then emits its x_gm_msgid via
 * the standard onBatch callback so it flows through the existing streaming
 * search pipeline.
 *
 * Flow:
 * 1. Check local DB (instant, no IMAP required).
 * 2. If not found locally, attempt IMAP fallback via ImapCrawlService.fetchEnvelopes().
 *    Upsert the fetched envelope into local DB, then emit the msgId.
 * 3. If IMAP is unavailable or the message cannot be found, return 'complete'
 *    with no results (the user will see an empty search result, which is acceptable).
 */

import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { ImapCrawlService } from './imap-crawl-service';
import { SearchOptions } from './search-options';

const log = LoggerService.getInstance();

export class MessageIdSearchService {
  constructor(
    private readonly databaseService: DatabaseService,
    private readonly imapCrawlService: ImapCrawlService,
  ) {}

  /**
   * Search for a single email by its x_gm_msgid.
   *
   * Emits the xGmMsgId via onBatch once the email is located (locally or via IMAP).
   * If the email cannot be found, emits an empty local batch and returns 'complete'.
   *
   * @param options - Must include xGmMsgId, accountId, and onBatch.
   * @returns 'complete' always (single-message lookups are either found or not).
   */
  async search(options: SearchOptions): Promise<'complete' | 'partial' | 'error'> {
    const { xGmMsgId, accountId, onBatch } = options;

    if (!xGmMsgId || !accountId || !onBatch) {
      log.warn('[MessageIdSearchService] Missing required options: xGmMsgId, accountId, onBatch');
      return 'complete';
    }

    try {
      // Step 1: Check local DB first — instant, no IMAP round-trip needed.
      // Also verify a threads row exists: getThreadsByXGmMsgIds joins emails→threads,
      // so an email with no thread row would resolve to 0 results and appear as a dead link.
      const localEmail = this.databaseService.getEmailByXGmMsgId(accountId, xGmMsgId);
      if (localEmail) {
        const xGmThrid = localEmail['xGmThrid'] as string | undefined;
        const threadExists = xGmThrid
          ? this.databaseService.getThreadById(accountId, xGmThrid) !== null
          : false;

        if (threadExists) {
          log.info(`[MessageIdSearchService] Found message ${xGmMsgId} in local DB`);
          onBatch([xGmMsgId], 'local');
          return 'complete';
        }

        log.info(`[MessageIdSearchService] Message ${xGmMsgId} found in emails table but has no thread row — falling back to IMAP`);
      }

      // Emit an empty local batch to signal local phase completion.
      onBatch([], 'local');

      // Step 2: IMAP fallback — fetch the envelope from [Gmail]/All Mail.
      log.info(`[MessageIdSearchService] Message ${xGmMsgId} not in local DB, trying IMAP fallback`);

      try {
        const accountIdStr = String(accountId);
        const envelopes = await this.imapCrawlService.fetchEnvelopes(accountIdStr, [xGmMsgId]);

        if (envelopes.length === 0) {
          log.info(`[MessageIdSearchService] IMAP fallback: message ${xGmMsgId} not found on server`);
          onBatch([], 'imap');
          return 'complete';
        }

        const envelope = envelopes[0];

        // Upsert into local DB before emitting so subsequent interactions hit the cache.
        try {
          this.databaseService.upsertEmailFromEnvelope(accountId, {
            xGmMsgId: envelope.xGmMsgId,
            xGmThrid: envelope.xGmThrid,
            messageId: envelope.messageId,
            subject: envelope.subject,
            fromAddress: envelope.fromAddress,
            fromName: envelope.fromName,
            toAddresses: envelope.toAddresses,
            date: envelope.date,
            isRead: envelope.isRead,
            isStarred: envelope.isStarred,
            isDraft: envelope.isDraft,
            size: envelope.size,
            rawLabels: envelope.rawLabels,
            uid: envelope.uid,
          });
          log.info(`[MessageIdSearchService] Upserted message ${xGmMsgId} from IMAP into local DB`);
        } catch (upsertError) {
          log.warn('[MessageIdSearchService] Failed to upsert envelope from IMAP:', upsertError);
          // Continue — we still have the xGmMsgId so we can emit it even if upsert failed.
        }

        onBatch([envelope.xGmMsgId], 'imap');
        return 'complete';
      } catch (imapError) {
        log.warn('[MessageIdSearchService] IMAP fallback failed:', imapError);
        onBatch([], 'imap');
        return 'complete';
      }
    } catch (fatalError) {
      log.error('[MessageIdSearchService] Unexpected error searching for message:', fatalError);
      return 'complete';
    }
  }
}
