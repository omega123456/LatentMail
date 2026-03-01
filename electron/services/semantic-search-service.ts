/**
 * SemanticSearchService — orchestrates vector similarity searches for the AI search pipeline.
 *
 * Flow:
 * 1. Embed the natural language query via OllamaService (single string, fast, runs on main thread)
 * 2. Run cosine similarity search via VectorDbService, filtered by account_id
 * 3. Deduplicate by x_gm_msgid (multiple chunks from the same email → keep highest score)
 * 4. Filter out emails whose ONLY folder associations are Trash, Spam, or Drafts
 * 5. For results not present in the local emails table, fetch envelope metadata from IMAP
 *    on demand via ImapCrawlService and upsert into the emails table for caching
 * 6. Return top 50 x_gm_msgid values sorted by similarity descending
 *
 * Fallback contract:
 * - Returns empty array if VectorDbService is unavailable, no embedding model is configured,
 *   or the similarity search returns fewer than MIN_RESULTS_THRESHOLD results above
 *   SIMILARITY_THRESHOLD. The caller is responsible for falling through to keyword search.
 */

import { LoggerService } from './logger-service';
import { OllamaService } from './ollama-service';
import { VectorDbService } from './vector-db-service';
import { DatabaseService } from './database-service';
import { ImapCrawlService, CrawlFetchResult } from './imap-crawl-service';

const log = LoggerService.getInstance();

/** Minimum cosine similarity score for a result to be considered relevant. */
const SIMILARITY_THRESHOLD = 0.5;

/** Minimum number of results above the threshold before we use semantic results. */
const MIN_RESULTS_THRESHOLD = 5;

/** Maximum number of results returned after deduplication and filtering. */
const MAX_RESULTS = 50;

/** Spam folder path (static, same across Gmail accounts). */
const SPAM_FOLDER = '[Gmail]/Spam';

/** Drafts folder path (static, same across Gmail accounts). */
const DRAFTS_FOLDER = '[Gmail]/Drafts';

export class SemanticSearchService {
  private static instance: SemanticSearchService;

  private constructor() {}

  static getInstance(): SemanticSearchService {
    if (!SemanticSearchService.instance) {
      SemanticSearchService.instance = new SemanticSearchService();
    }
    return SemanticSearchService.instance;
  }

  /**
   * Run a semantic similarity search for the given natural language query.
   *
   * @param naturalQuery - The user's search query (natural language)
   * @param accountId - The account to search within
   * @returns Array of x_gm_msgid values sorted by relevance descending,
   *          or empty array if semantic search is unavailable or returns too few results.
   */
  async search(naturalQuery: string, accountId: number): Promise<string[]> {
    const vectorDb = VectorDbService.getInstance();

    if (!vectorDb.vectorsAvailable) {
      log.debug('[SemanticSearch] Vector DB unavailable — skipping semantic search');
      return [];
    }

    const ollama = OllamaService.getInstance();
    const embeddingModel = ollama.getEmbeddingModel();

    if (!embeddingModel) {
      log.debug('[SemanticSearch] No embedding model configured — skipping semantic search');
      return [];
    }

    if (!vectorDb.getVectorDimension()) {
      log.debug('[SemanticSearch] Vector dimension not configured — skipping semantic search');
      return [];
    }

    // Embed the query (single string, fast)
    let queryEmbedding: number[];
    try {
      const embeddings = await ollama.embed([naturalQuery]);
      if (!embeddings[0] || embeddings[0].length === 0) {
        log.warn('[SemanticSearch] Empty embedding returned for query');
        return [];
      }
      queryEmbedding = embeddings[0];
    } catch (embedError) {
      log.warn('[SemanticSearch] Failed to embed query:', embedError);
      return [];
    }

    // Run similarity search — fetch more candidates than needed to allow for filtering
    const rawResults = vectorDb.search(queryEmbedding, accountId, 100);

    if (rawResults.length === 0) {
      log.info('[SemanticSearch] No vector search results — falling back to keywords');
      return [];
    }

    // Deduplicate by x_gm_msgid: keep the highest similarity score per email
    const bestScoreByMsgId = new Map<string, number>();
    for (const result of rawResults) {
      const existing = bestScoreByMsgId.get(result.xGmMsgId);
      if (existing === undefined || result.similarity > existing) {
        bestScoreByMsgId.set(result.xGmMsgId, result.similarity);
      }
    }

    // Filter by similarity threshold
    const aboveThreshold = Array.from(bestScoreByMsgId.entries())
      .filter(([, score]) => score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b[1] - a[1])
      .map(([xGmMsgId]) => xGmMsgId);

    if (aboveThreshold.length < MIN_RESULTS_THRESHOLD) {
      log.info(
        `[SemanticSearch] Insufficient results: ${aboveThreshold.length} above threshold ` +
        `(need ≥${MIN_RESULTS_THRESHOLD}) — falling back to keywords`
      );
      return [];
    }

    // Filter out emails whose ONLY folder associations are Trash, Spam, or Drafts
    const db = DatabaseService.getInstance();

    // Resolve the trash folder dynamically (supports [Gmail]/Bin and other locales).
    // Per codebase conventions, never hardcode '[Gmail]/Trash'.
    const trashFolder = db.getTrashFolder(accountId);
    const excludedFolders = [trashFolder, SPAM_FOLDER, DRAFTS_FOLDER];

    const filteredMsgIds = this.filterExcludedFolders(db, accountId, aboveThreshold, excludedFolders);

    const finalResults = filteredMsgIds.slice(0, MAX_RESULTS);

    log.info(`[SemanticSearch] Semantic search: ${finalResults.length} results above threshold (${aboveThreshold.length} before folder filter)`);

    // Resolve any results that are missing from the local emails table by fetching
    // their envelope metadata from IMAP on demand. This handles the case where the
    // vector index contains emails that were never locally synced (full-mailbox crawl).
    await this.resolveUnknownEmails(db, accountId, finalResults);

    return finalResults;
  }

  /**
   * For any x_gm_msgid values in the results that are not in the local emails table,
   * fetch their envelope metadata from IMAP on demand and upsert into the emails table.
   * Missing/unfetchable emails are silently ignored — the caller will get empty thread
   * rows for those IDs when resolving via getThreadsByXGmMsgIds().
   *
   * @param db - DatabaseService instance
   * @param accountId - Account ID
   * @param xGmMsgIds - Result message IDs to check (relevance-ordered)
   */
  private async resolveUnknownEmails(
    db: DatabaseService,
    accountId: number,
    xGmMsgIds: string[]
  ): Promise<void> {
    if (xGmMsgIds.length === 0) {
      return;
    }

    let existingMsgIds: Set<string>;
    try {
      existingMsgIds = db.getEmailsExistingInLocalDb(accountId, xGmMsgIds);
    } catch (err) {
      log.warn('[SemanticSearch] Failed to check local email existence:', err);
      return;
    }

    const missingMsgIds = xGmMsgIds.filter((msgId) => !existingMsgIds.has(msgId));
    if (missingMsgIds.length === 0) {
      return;
    }

    log.info(`[SemanticSearch] Fetching ${missingMsgIds.length} envelope(s) from IMAP for un-synced search results`);

    const accountIdStr = String(accountId);
    let envelopes: CrawlFetchResult[];
    try {
      envelopes = await ImapCrawlService.getInstance().fetchEnvelopes(accountIdStr, missingMsgIds);
    } catch (err) {
      log.warn('[SemanticSearch] Failed to fetch envelopes from IMAP:', err);
      return;
    }

    // Upsert each fetched envelope into the local emails table
    for (const envelope of envelopes) {
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
        });
      } catch (err) {
        log.warn(`[SemanticSearch] Failed to upsert envelope for ${envelope.xGmMsgId}:`, err);
      }
    }

    log.info(`[SemanticSearch] Upserted ${envelopes.length} envelope(s) into local DB`);
  }

  /**
   * Filter out x_gm_msgid values that are ONLY in excluded folders (Trash, Spam, Drafts).
   * An email is included in results if it has at least one folder association that is
   * NOT in the excluded set.
   *
   * Emails with NO folder associations in email_folders (un-synced emails from the
   * full-mailbox crawl) are always included — the vector indexer already filtered
   * spam/trash/drafts at index time, so these are guaranteed to be valid emails.
   *
   * @param db - DatabaseService instance
   * @param accountId - Account ID
   * @param xGmMsgIds - Candidate message IDs (sorted by relevance)
   * @param excludedFolders - Folders to exclude (resolved dynamically for this account)
   * @returns Filtered list preserving the original ordering
   */
  private filterExcludedFolders(
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
      log.warn('[SemanticSearch] Failed to filter by folder exclusions, returning unfiltered results:', filterError);
      // Return unfiltered rather than throwing — better to show some results than none
      return xGmMsgIds;
    }
  }
}


