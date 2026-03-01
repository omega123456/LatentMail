/**
 * SemanticSearchService — orchestrates vector similarity searches for the AI search pipeline.
 *
 * Flow:
 * 1. Embed the natural language query via OllamaService (single string, fast, runs on main thread)
 * 2. Run cosine similarity search via VectorDbService, filtered by account_id
 * 3. Deduplicate by x_gm_msgid (multiple chunks from the same email → keep highest score)
 * 4. Filter out emails whose ONLY folder associations are Trash, Spam, or Drafts
 * 5. Return top 50 x_gm_msgid values sorted by similarity descending
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

    log.info('[SemanticSearch] Request', {
      query: naturalQuery.length > 200 ? naturalQuery.slice(0, 200) + '…' : naturalQuery,
      queryLength: naturalQuery.length,
      accountId,
    });

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
      log.info('[SemanticSearch] Query embedded', {
        dimension: queryEmbedding.length,
        accountId,
        limit: 100,
      });
    } catch (embedError) {
      log.warn('[SemanticSearch] Failed to embed query:', embedError);
      return [];
    }

    // Run similarity search — fetch more candidates than needed to allow for filtering
    const rawResults = vectorDb.search(queryEmbedding, accountId, 100);

    log.info('[SemanticSearch] Vector search response', {
      rawResultCount: rawResults.length,
      topScores:
        rawResults.length > 0
          ? rawResults.map((result) => ({ xGmMsgId: result.xGmMsgId, similarity: result.similarity }))
          : [],
    });

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

    log.info('[SemanticSearch] After dedup and threshold', {
      aboveThresholdCount: aboveThreshold.length,
      threshold: SIMILARITY_THRESHOLD,
      minRequired: MIN_RESULTS_THRESHOLD,
    });

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

    log.info('[SemanticSearch] Final result', {
      returnedCount: finalResults.length,
      beforeFolderFilter: aboveThreshold.length,
      maxResults: MAX_RESULTS,
    });

    return finalResults;
  }

  /**
   * Filter out x_gm_msgid values that are ONLY in excluded folders (Trash, Spam, Drafts).
   * An email is included in results if it has at least one folder association that is
   * NOT in the excluded set.
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
      return xGmMsgIds.filter((msgId) => includedSet.has(msgId));
    } catch (filterError) {
      log.warn('[SemanticSearch] Failed to filter by folder exclusions, returning unfiltered results:', filterError);
      // Return unfiltered rather than throwing — better to show some results than none
      return xGmMsgIds;
    }
  }
}


