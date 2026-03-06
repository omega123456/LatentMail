/**
 * BaseSearchService — abstract base class providing shared helpers for email search services.
 *
 * Subclasses implement the abstract `search()` method and inherit protected utilities
 * for sorting results by date, filtering excluded folders, upsert from crawl, building
 * Gmail raw queries, and running local DB searches by Gmail query string.
 */

import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { ImapCrawlService, CrawlFetchResult } from './imap-crawl-service';
import { parseGmailQuery } from '../utils/gmail-query-parser';
import { SearchOptions, SearchBatchCallback } from './search-options';

const log = LoggerService.getInstance();

/**
 * Re-export SearchBatchCallback from search-options for backward compatibility.
 * New code should import directly from './search-options'.
 */
export type { SearchBatchCallback };

export abstract class BaseSearchService {
  /** Maximum number of results returned after deduplication and filtering. */
  protected readonly MAX_RESULTS = 50;

  /** Spam folder path (static, same across Gmail accounts). */
  protected readonly SPAM_FOLDER = '[Gmail]/Spam';

  /** Drafts folder path (static, same across Gmail accounts). */
  protected readonly DRAFTS_FOLDER = '[Gmail]/Drafts';

  /** Mailbox path used for all IMAP resolution operations. */
  protected readonly ALL_MAIL_PATH = '[Gmail]/All Mail';

  protected constructor() {}

  /**
   * Run a search and deliver results incrementally via the onBatch callback
   * in the provided SearchOptions.
   *
   * @param options - Search options including query, accountId, userEmail, todayDate,
   *                  folders, onBatch callback, and optionally xGmMsgId for single-message lookup.
   * @returns 'complete' if all phases succeeded, 'partial' if some IMAP rounds failed
   *          but some results were emitted, 'error' if the search failed entirely before
   *          any results could be produced.
   */
  abstract search(options: SearchOptions): Promise<'complete' | 'partial' | 'error'>;

  /**
   * Sort x_gm_msgid values by their email date, newest first.
   * Message IDs with no date record in the local DB are placed at the end.
   *
   * @param accountId - Account ID to scope the date lookup
   * @param msgIds - Message IDs to sort
   * @returns Sorted array (date descending, un-dated entries last)
   */
  protected sortByDate(accountId: number, msgIds: string[]): string[] {
    if (msgIds.length === 0) {
      return [];
    }

    const db = DatabaseService.getInstance();
    const dateMap = db.getEmailDatesByMsgIds(accountId, msgIds);

    const sorted = [...msgIds].sort((idA, idB) => {
      const dateA = dateMap.get(idA);
      const dateB = dateMap.get(idB);

      // Entries without a date record go to the end of the sorted array.
      if (!dateA && !dateB) {
        return 0;
      }
      if (!dateA) {
        return 1;
      }
      if (!dateB) {
        return -1;
      }

      // Sort newest first (descending).
      return dateB.localeCompare(dateA);
    });

    return sorted;
  }

  /**
   * Filter out x_gm_msgid values that are ONLY in excluded folders (Trash, Spam, Drafts).
   * An email is included in results if it has at least one folder association that is
   * NOT in the excluded set.
   *
   * Emails with NO folder associations in email_folders (un-synced emails from the
   * full-mailbox crawl) are always included here — they have no local folder data.
   * These un-synced emails are subsequently re-checked after fetching from IMAP using
   * their server-side rawLabels (via the X-GM-RAW filter in filterAndResolve).
   *
   * @param db - DatabaseService instance
   * @param accountId - Account ID
   * @param xGmMsgIds - Candidate message IDs (sorted by relevance)
   * @param excludedFolders - Folders to exclude (resolved dynamically for this account)
   * @returns Filtered list preserving the original ordering
   */
  protected filterExcludedFolders(
    db: DatabaseService,
    accountId: number,
    xGmMsgIds: string[],
    excludedFolders: string[]
  ): string[] {
    if (xGmMsgIds.length === 0) {
      return [];
    }

    try {
      const includedSet = db.getMsgIdsWithNonExcludedFolders(accountId, xGmMsgIds, excludedFolders);
      // For results with no email_folders entries (un-synced emails from full-mailbox crawl),
      // getMsgIdsWithNonExcludedFolders will return nothing. We need to identify which msgIds
      // have NO folder records at all (distinct from having only excluded-folder records) so
      // they can be passed through. Use a single batched query for this.
      const hasAnyFolder = db.getMsgIdsWithAnyFolder(accountId, xGmMsgIds);
      return xGmMsgIds.filter((msgId) => includedSet.has(msgId) || !hasAnyFolder.has(msgId));
    } catch (filterError) {
      log.warn('[Search] Failed to filter by folder exclusions, returning unfiltered results:', filterError);
      // Return unfiltered rather than throwing — better to show some results than none
      return xGmMsgIds;
    }
  }

  /**
   * Upsert a single envelope from IMAP crawl into the DB. Logs and swallows errors.
   *
   * @param accountId - Account ID to associate the email with
   * @param envelope - Crawl fetch result containing envelope data
   * @param logContext - Label for log messages (e.g. 'Round 1', 'Filter-only fallback')
   */
  protected upsertEnvelopeFromCrawl(
    accountId: number,
    envelope: CrawlFetchResult,
    logContext: string
  ): void {
    const db = DatabaseService.getInstance();
    try {
      db.upsertEmailFromEnvelope(accountId, {
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
    } catch (upsertError) {
      log.warn(`[Search] ${logContext}: failed to upsert envelope:`, upsertError);
    }
  }

  /**
   * Build Gmail raw query string with standard folder exclusions (trash, spam, drafts).
   *
   * @param filterQuery - Base Gmail filter query (may be empty)
   * @returns Combined query string with folder exclusion clauses appended
   */
  protected buildGmRawWithExclusions(filterQuery: string): string {
    const folderExclusionClause = '-in:trash -in:spam -in:drafts';
    return [filterQuery, folderExclusionClause]
      .filter((part) => part.length > 0)
      .join(' ');
  }

  /**
   * Run local DB search by Gmail query string; returns x_gm_msgid list ordered by date DESC.
   *
   * @param accountId - Account ID to scope the search
   * @param gmailQuery - Gmail-syntax query string (already includes folder exclusions)
   * @param limit - Maximum number of results to return
   * @returns Array of x_gm_msgid strings ordered by date descending
   */
  protected runLocalSearchByGmailQuery(
    accountId: number,
    gmailQuery: string,
    limit: number
  ): string[] {
    const db = DatabaseService.getInstance();
    const parsed = parseGmailQuery(gmailQuery, {
      accountId,
      paramPrefix: 'fof_',
      trashFolderResolver: (resolverAccountId?: number) => db.getTrashFolder(resolverAccountId ?? accountId),
    });

    const localParams = {
      accountId,
      limit,
      ...parsed.params,
    } as Record<string, number | string | null>;

    const rawDb = db.getDatabase();
    try {
      const rows = rawDb.prepare(
        `SELECT DISTINCT e.x_gm_msgid
         FROM emails e
         WHERE e.account_id = :accountId
           AND (${parsed.whereClause})
         ORDER BY e.date DESC
         LIMIT :limit`
      ).all(localParams) as Array<Record<string, unknown>>;

      return rows
        .map((row) => row['x_gm_msgid'] as string | null)
        .filter((msgId): msgId is string => msgId !== null && msgId.length > 0);
    } catch (localSearchError) {
      log.warn('[Search] Local DB search failed:', localSearchError);
      return [];
    }
  }
}
