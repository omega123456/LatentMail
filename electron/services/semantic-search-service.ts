/**
 * SemanticSearchService — orchestrates vector similarity searches for the AI search pipeline.
 *
 * Flow:
 * 1. Extract structured semantic intent via OllamaService (splits query into topic + filters)
 * 2. Embed the semantic topic query via OllamaService (single string, fast, runs on main thread)
 * 3. Run cosine similarity search via VectorDbService, filtered by account_id
 * 4. Deduplicate by x_gm_msgid (multiple chunks from the same email → keep highest score)
 * 5. Filter by similarity threshold, then sort by similarity descending.
 * 6. Filter out emails whose ONLY folder associations are Trash, Spam, or Drafts (local DB check).
 *    Un-synced emails (no email_folders rows) pass through here and are re-checked after IMAP fetch.
 * 7a. If structured filters present: apply via SQL (local DB) + IMAP (missing emails),
 *     fetch envelopes for missing emails, check rawLabels + isDraft to exclude Trash/Spam/Drafts-only,
 *     upsert only non-excluded envelopes, then sort by date descending.
 * 7b. If no structured filters: resolve unknown emails via ImapCrawlService, check rawLabels +
 *     isDraft for each fetched envelope and exclude Trash/Spam/Drafts-only, upsert only non-excluded,
 *     backfill from remaining candidates if any were excluded to maintain up to MAX_RESULTS,
 *     return similarity-sorted results (no minimum-count gate).
 *
 * Returns empty array only when VectorDbService is unavailable, no embedding model is
 * configured, or the similarity search returns no raw results. No fallback to keyword search.
 */

import { LoggerService } from './logger-service';
import { OllamaService } from './ollama-service';
import { VectorDbService } from './vector-db-service';
import { DatabaseService } from './database-service';
import { ImapService } from './imap-service';
import { ImapCrawlService, CrawlFetchResult } from './imap-crawl-service';
import {
  SemanticSearchFilters,
  SemanticSearchIntent,
  translateFiltersToGmailQuery,
  hasFilters,
} from '../utils/search-filter-translator';

const log = LoggerService.getInstance();

/** Minimum cosine similarity score for a result to be considered relevant. */
const SIMILARITY_THRESHOLD = 0.5;

/** Maximum number of results returned after deduplication and filtering. */
const MAX_RESULTS = 50;

/** Spam folder path (static, same across Gmail accounts). */
const SPAM_FOLDER = '[Gmail]/Spam';

/** Drafts folder path (static, same across Gmail accounts). */
const DRAFTS_FOLDER = '[Gmail]/Drafts';

/** Maximum number of results returned from vector search. */
const MAX_VECTOR_SEARCH_RESULTS = 450;

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
   * Extracts structured intent (topic query + filters) from the natural language query,
   * embeds the topic query, runs vector search, then applies either a structured filter
   * path (SQL + IMAP) or a threshold quality gate path depending on whether the LLM
   * extracted any filters.
   *
   * @param naturalQuery - The user's search query (natural language)
   * @param accountId - The account to search within
   * @param userEmail - The account's email address (for LLM context)
   * @param todayDate - Today's date as YYYY-MM-DD (for LLM relative-date resolution)
   * @param folders - List of folder names for LLM context
   * @returns Array of x_gm_msgid values sorted by relevance or date,
   *          or empty array only if semantic search is unavailable or returns no raw results.
   */
  async search(
    naturalQuery: string,
    accountId: number,
    userEmail: string,
    todayDate: string,
    folders: string[]
  ): Promise<string[]> {
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

    // Step 1: Extract structured semantic intent (topic query + structured filters).
    // Fall back to treating the raw query as the semantic query if LLM extraction fails.
    let intent: SemanticSearchIntent;
    try {
      intent = await ollama.extractSemanticIntent(naturalQuery, userEmail, todayDate, folders);
    } catch (intentError) {
      log.warn('[SemanticSearch] Intent extraction failed, using raw query as semantic query:', intentError);
      intent = { semanticQuery: naturalQuery, filters: {} };
    }

    log.info('[SemanticSearch] Extracted intent:', JSON.stringify(intent));

    // Step 2: Embed the semantic topic query (strip filter qualifiers, embed topic only).
    let queryEmbedding: number[];
    try {
      const embeddings = await ollama.embed([intent.semanticQuery]);
      if (!embeddings[0] || embeddings[0].length === 0) {
        log.warn('[SemanticSearch] Empty embedding returned for query');
        return [];
      }
      queryEmbedding = embeddings[0];
    } catch (embedError) {
      log.warn('[SemanticSearch] Failed to embed query:', embedError);
      return [];
    }

    // Step 3: Run similarity search — fetch more candidates than needed to allow for filtering.
    const rawResults = vectorDb.search(queryEmbedding, accountId, MAX_VECTOR_SEARCH_RESULTS);

    if (rawResults.length === 0) {
      log.info('[SemanticSearch] No vector search results');
      return [];
    }

    // Step 4: Deduplicate by x_gm_msgid: keep the highest similarity score per email.
    const bestScoreByMsgId = new Map<string, number>();
    for (const result of rawResults) {
      const existing = bestScoreByMsgId.get(result.xGmMsgId);
      if (existing === undefined || result.similarity > existing) {
        bestScoreByMsgId.set(result.xGmMsgId, result.similarity);
      }
    }

    // Step 5: Filter by similarity threshold, then sort by similarity descending.
    const sortedBySimilarity = Array.from(bestScoreByMsgId.entries())
      .filter(([, score]) => score >= SIMILARITY_THRESHOLD)
      .sort((a, b) => b[1] - a[1])
      .map(([xGmMsgId]) => xGmMsgId);

    // Step 6: Filter out emails whose ONLY folder associations are Trash, Spam, or Drafts.
    const db = DatabaseService.getInstance();

    // Resolve the trash folder dynamically (supports [Gmail]/Bin and other locales).
    // Per codebase conventions, never hardcode '[Gmail]/Trash'.
    const trashFolder = db.getTrashFolder(accountId);
    const excludedFolders = [trashFolder, SPAM_FOLDER, DRAFTS_FOLDER];

    const folderFilteredMsgIds = this.filterExcludedFolders(db, accountId, sortedBySimilarity, excludedFolders);

    // Step 7: Branch on whether the LLM extracted any structured filters.
    if (hasFilters(intent.filters)) {
      // Structured filter path: apply SQL + IMAP filters, sort by date descending.
      log.info(
        `[SemanticSearch] Applying structured filters to ${folderFilteredMsgIds.length} candidates ` +
        `(${sortedBySimilarity.length} before folder filter)`
      );
      const filteredMsgIds = await this.applyStructuredFilters(
        accountId,
        folderFilteredMsgIds,
        intent.filters,
        excludedFolders
      );
      const sortedMsgIds = this.sortByDate(accountId, filteredMsgIds);
      const finalResults = sortedMsgIds.slice(0, MAX_RESULTS);

      log.info(`[SemanticSearch] Structured filter path: ${finalResults.length} final results`);
      return finalResults;
    }

    // No-filter path: resolve unknown emails and return similarity-sorted results.
    // Use a backfill loop: if some resolved emails turn out to be Trash/Spam/Drafts-only,
    // replace them from the remaining candidates in folderFilteredMsgIds to maintain MAX_RESULTS.
    let verifiedResults: string[] = [];
    let candidateOffset = 0;
    const allCandidates = folderFilteredMsgIds; // Full pre-slice candidate list (similarity-ordered)

    while (verifiedResults.length < MAX_RESULTS && candidateOffset < allCandidates.length) {
      // How many more results we still need.
      const remaining = MAX_RESULTS - verifiedResults.length;
      // Take the next batch of candidates.
      const batch = allCandidates.slice(candidateOffset, candidateOffset + remaining);
      candidateOffset += batch.length;

      // Resolve this batch: fetch envelopes for un-synced emails, filter by excluded folders.
      const excludedInBatch = await this.resolveUnknownEmails(db, accountId, batch, excludedFolders);

      // Keep only the non-excluded candidates from this batch.
      const verifiedBatch = batch.filter((msgId) => !excludedInBatch.has(msgId));
      verifiedResults = verifiedResults.concat(verifiedBatch);

      // If no exclusions occurred there is no point taking more candidates.
      if (excludedInBatch.size === 0) {
        break;
      }
    }

    log.info(
      `[SemanticSearch] Semantic search: ${verifiedResults.length} results ` +
      `(${sortedBySimilarity.length} before folder filter, ${allCandidates.length} after local folder filter)`
    );

    return verifiedResults;
  }

  /**
   * Apply structured filters to a list of candidate x_gm_msgid values.
   *
   * Partitions the candidates into locally-present vs. missing (in vector index
   * but not yet in local DB). Local candidates are filtered via SQL. Missing
   * candidates are filtered via IMAP X-GM-RAW search and then fetched as envelopes
   * so they are available in the local DB for subsequent rendering.
   *
   * After fetching envelopes, each one is checked against rawLabels + isDraft to
   * exclude Trash/Spam/Drafts-only emails (server-side authoritative folder check).
   * Only non-excluded envelopes are upserted into the local DB.
   * If fetchEnvelopes() fails, all missing IDs are dropped (cannot verify folder status).
   *
   * @param accountId - Account ID to scope queries
   * @param msgIds - Candidate message IDs (similarity-ordered)
   * @param filters - Structured filter constraints from LLM intent extraction
   * @param excludedFolders - Folders to exclude (Trash, Spam, Drafts — resolved for this account)
   * @returns Merged array of message IDs that satisfy the filter constraints
   */
  private async applyStructuredFilters(
    accountId: number,
    msgIds: string[],
    filters: SemanticSearchFilters,
    excludedFolders: string[]
  ): Promise<string[]> {
    const db = DatabaseService.getInstance();

    // Partition into locally-present vs. missing IDs.
    let localMsgIds: Set<string>;
    try {
      localMsgIds = db.getEmailsExistingInLocalDb(accountId, msgIds);
    } catch (err) {
      log.warn('[SemanticSearch] Failed to check local email existence in applyStructuredFilters:', err);
      localMsgIds = new Set<string>();
    }

    const missingMsgIds = msgIds.filter((msgId) => !localMsgIds.has(msgId));

    // Filter locally-present emails via SQL.
    let filteredLocalMsgIds: Set<string>;
    try {
      filteredLocalMsgIds = db.filterEmailsByMsgIds(accountId, Array.from(localMsgIds), filters);
    } catch (err) {
      log.warn('[SemanticSearch] SQL filter failed, using unfiltered local IDs:', err);
      filteredLocalMsgIds = localMsgIds;
    }

    // Filter missing emails via IMAP X-GM-RAW search.
    const gmailQuery = translateFiltersToGmailQuery(filters);
    let intersectedMissingMsgIds: string[] = [];

    if (missingMsgIds.length > 0) {
      if (!gmailQuery) {
        // No translatable filters — accept all missing IDs without IMAP round-trip.
        intersectedMissingMsgIds = missingMsgIds;
      } else {
        try {
          const imap = ImapService.getInstance();
          const imapResults = await imap.searchEmails(String(accountId), gmailQuery, 200);
          const imapMsgIdSet = new Set<string>(imapResults.map((result) => result.xGmMsgId));
          intersectedMissingMsgIds = missingMsgIds.filter((msgId) => imapMsgIdSet.has(msgId));
        } catch (imapErr) {
          log.warn('[SemanticSearch] IMAP filter failed, using local results only:', imapErr);
          intersectedMissingMsgIds = [];
        }
      }

      // Fetch envelopes for missing IDs, check excluded folders, and upsert non-excluded ones.
      // The gmailQuery === null path (all missing IDs accepted) also requires the folder check —
      // rawLabels filtering applies uniformly after fetchEnvelopes() regardless of gmailQuery.
      if (intersectedMissingMsgIds.length > 0) {
        let envelopes: CrawlFetchResult[];
        try {
          envelopes = await ImapCrawlService.getInstance().fetchEnvelopes(
            String(accountId),
            intersectedMissingMsgIds
          );
        } catch (fetchErr) {
          log.warn('[SemanticSearch] Failed to fetch envelopes for missing IDs — dropping all un-verifiable IDs:', fetchErr);
          // Deliberate behavioral change: drop all un-verifiable IDs rather than risk showing
          // Trash/Spam emails. Non-fatal network errors may cause some valid results to be lost.
          intersectedMissingMsgIds = [];
          envelopes = [];
        }

        if (envelopes.length > 0) {
          const { excludedMsgIds, upsertedCount } = this.filterEnvelopesAndUpsert(
            db,
            accountId,
            envelopes,
            excludedFolders
          );

          log.info(
            `[SemanticSearch] applyStructuredFilters: ${upsertedCount} envelope(s) upserted, ` +
            `${excludedMsgIds.size} excluded (Trash/Spam/Drafts-only)`
          );

          // Remove excluded IDs from the intersected missing list.
          intersectedMissingMsgIds = intersectedMissingMsgIds.filter(
            (msgId) => !excludedMsgIds.has(msgId)
          );
        }
      }
    }

    // Merge: combine SQL-filtered local IDs + IMAP-intersected missing IDs (deduplicated).
    const mergedSet = new Set<string>(filteredLocalMsgIds);
    for (const msgId of intersectedMissingMsgIds) {
      mergedSet.add(msgId);
    }

    return Array.from(mergedSet);
  }

  /**
   * Sort x_gm_msgid values by their email date, newest first.
   * Message IDs with no date record in the local DB are placed at the end.
   *
   * @param accountId - Account ID to scope the date lookup
   * @param msgIds - Message IDs to sort
   * @returns Sorted array (date descending, un-dated entries last)
   */
  private sortByDate(accountId: number, msgIds: string[]): string[] {
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
   * For any x_gm_msgid values in the results that are not in the local emails table,
   * fetch their envelope metadata from IMAP on demand and upsert into the emails table.
   *
   * Each fetched envelope is checked against excludedFolders using rawLabels + isDraft:
   * emails that exist only in Trash/Spam/Drafts are not upserted and their msgIds are
   * returned in the excluded set. Emails with empty rawLabels and isDraft === false are
   * passed through (safer to show than suppress when folder data is ambiguous).
   *
   * Missing/unfetchable emails are silently ignored — the caller will get empty thread
   * rows for those IDs when resolving via getThreadsByXGmMsgIds().
   *
   * @param db - DatabaseService instance
   * @param accountId - Account ID
   * @param xGmMsgIds - Result message IDs to check (relevance-ordered)
   * @param excludedFolders - Folders to exclude (Trash, Spam, Drafts — resolved for this account)
   * @returns Set of msgIds that were excluded due to being Trash/Spam/Drafts-only
   */
  private async resolveUnknownEmails(
    db: DatabaseService,
    accountId: number,
    xGmMsgIds: string[],
    excludedFolders: string[]
  ): Promise<Set<string>> {
    if (xGmMsgIds.length === 0) {
      return new Set<string>();
    }

    let existingMsgIds: Set<string>;
    try {
      existingMsgIds = db.getEmailsExistingInLocalDb(accountId, xGmMsgIds);
    } catch (err) {
      log.warn('[SemanticSearch] Failed to check local email existence:', err);
      return new Set<string>();
    }

    const missingMsgIds = xGmMsgIds.filter((msgId) => !existingMsgIds.has(msgId));
    if (missingMsgIds.length === 0) {
      return new Set<string>();
    }

    log.info(`[SemanticSearch] Fetching ${missingMsgIds.length} envelope(s) from IMAP for un-synced search results`);

    const accountIdStr = String(accountId);
    let envelopes: CrawlFetchResult[];
    try {
      envelopes = await ImapCrawlService.getInstance().fetchEnvelopes(accountIdStr, missingMsgIds);
    } catch (err) {
      log.warn('[SemanticSearch] Failed to fetch envelopes from IMAP:', err);
      return new Set<string>();
    }

    const { excludedMsgIds: toExclude, upsertedCount } = this.filterEnvelopesAndUpsert(
      db,
      accountId,
      envelopes,
      excludedFolders
    );

    log.info(
      `[SemanticSearch] resolveUnknownEmails: ${upsertedCount} envelope(s) upserted, ` +
      `${toExclude.size} excluded (Trash/Spam/Drafts-only)`
    );

    return toExclude;
  }

  /**
   * Filter envelopes by excluded folders (Trash/Spam/Drafts) and upsert non-excluded ones
   * into the local DB. Used by applyStructuredFilters and resolveUnknownEmails.
   *
   * @param db - DatabaseService instance
   * @param accountId - Account ID
   * @param envelopes - Fetched envelopes from ImapCrawlService
   * @param excludedFolders - Folders to exclude (Trash, Spam, Drafts — resolved for this account)
   * @returns Set of excluded msgIds and count of envelopes upserted
   */
  private filterEnvelopesAndUpsert(
    db: DatabaseService,
    accountId: number,
    envelopes: CrawlFetchResult[],
    excludedFolders: string[]
  ): { excludedMsgIds: Set<string>; upsertedCount: number } {
    const excludedMsgIds = new Set<string>();
    let upsertedCount = 0;

    for (const envelope of envelopes) {
      if (this.isOnlyInExcludedFolders(envelope, excludedFolders)) {
        excludedMsgIds.add(envelope.xGmMsgId);
      } else {
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
          });
          upsertedCount++;
        } catch (err) {
          log.warn(`[SemanticSearch] Failed to upsert envelope for ${envelope.xGmMsgId}:`, err);
        }
      }
    }

    return { excludedMsgIds, upsertedCount };
  }

  /**
   * Filter out x_gm_msgid values that are ONLY in excluded folders (Trash, Spam, Drafts).
   * An email is included in results if it has at least one folder association that is
   * NOT in the excluded set.
   *
   * Emails with NO folder associations in email_folders (un-synced emails from the
   * full-mailbox crawl) are always included here — they have no local folder data.
   * These un-synced emails are subsequently re-checked after fetching from IMAP using
   * their server-side rawLabels (in resolveUnknownEmails or applyStructuredFilters).
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

  /**
   * Determine whether a server-fetched envelope exists only in excluded folders.
   *
   * Uses rawLabels from CrawlFetchResult as the authoritative server-side folder info.
   * For Spam and Trash, rawLabels contains folder path strings (e.g., '[Gmail]/Spam').
   * For Drafts, the '\Draft' system flag is more reliable than the folder path, so we
   * also check isDraft — following the same pattern as embedding-service.ts.
   *
   * Edge cases:
   * - rawLabels empty + isDraft false → pass through (ambiguous; safer to show than suppress)
   * - rawLabels empty + isDraft true → exclude (draft with no other folder)
   * - rawLabels has at least one non-excluded label → pass through (email is visible elsewhere)
   *
   * @param envelope - Server-fetched envelope from ImapCrawlService.fetchEnvelopes()
   * @param excludedFolders - Folders to treat as excluded (Trash, Spam, Drafts paths)
   * @returns true if the email should be excluded from search results; false otherwise
   */
  private isOnlyInExcludedFolders(
    envelope: CrawlFetchResult,
    excludedFolders: string[]
  ): boolean {
    const excludedSet = new Set<string>(excludedFolders);

    if (envelope.rawLabels.length === 0) {
      // No folder path labels: exclude only if the \Draft system flag is set.
      return envelope.isDraft;
    }

    // Exclude if every label is in the excluded set (email lives only in excluded folders).
    return envelope.rawLabels.every((label) => excludedSet.has(label));
  }
}
