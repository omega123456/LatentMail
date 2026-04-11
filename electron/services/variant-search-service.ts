import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { OllamaService } from './ollama-service';
import { VectorDbService, VectorSearchResult } from './vector-db-service';
import { BaseSearchService } from './base-search-service';
import { SemanticSearchFilters, hasFilters } from '../utils/search-filter-translator';
import { loadPrompt } from '../utils/prompt-loader';

const log = LoggerService.getInstance();

/** Structured result returned by the multi-query rewriter for a single variant. */
export interface RewriteResult {
  query: string;
  filters: SemanticSearchFilters;
  /** Sort direction for results. Defaults to 'desc' (newest first). */
  dateOrder: 'asc' | 'desc';
}

/** Email chunk enriched with metadata from the local database. */
export interface EnrichedChunk {
  xGmMsgId: string;
  fromName: string;
  fromAddress: string;
  toAddresses: string;
  subject: string;
  date: string;
  chunkText: string;
}

/** A single turn in the conversation history. */
export interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Result of a successful variant search pipeline run. */
export interface VariantSearchResult {
  enrichedChunks: EnrichedChunk[];
  contextString: string;
  allMsgIds: string[];
  filters: SemanticSearchFilters;
}

/** Maximum number of vector search candidate chunks when no filters are present. */
const VECTOR_CANDIDATE_BUDGET = 1360;

/**
 * Minimum cosine similarity score for a chunk to be considered relevant when
 * no structured filters are present. When DB filters are active the threshold
 * is not applied — the filters themselves narrow the candidate set.
 */
const SIMILARITY_THRESHOLD = 0.5;

/** Maximum number of chunks to pass downstream after all filtering is applied. */
const FINAL_CHUNK_LIMIT = 15;

/**
 * VariantSearchService encapsulates the multi-variant retrieval pipeline:
 *
 * 1. Rewrite the user's question into 5 query variants (via LLM)
 * 2. Batch-embed all unique query strings
 * 3. For each variant: vector search → DB filter → folder exclusion → enrichment → relevance check
 * 4. Early-stop at the first relevant variant, return enriched chunks + context string
 *
 * This service is NOT a singleton — consumers instantiate it with their dependencies.
 */
export class VariantSearchService {
  constructor(
    private db: DatabaseService,
    private ollama: OllamaService,
    private vectorDb: VectorDbService,
  ) {}

  /**
   * Run the multi-variant search pipeline for the given question.
   *
   * @param question - The user's question
   * @param conversationHistory - Prior turns in the conversation
   * @param accountId - Account to search
   * @param signal - Optional abort signal for cancellation
   * @param todayDate - Today's date in YYYY-MM-DD format (defaults to local today)
   * @param userEmail - The user's email address (for self-reference resolution)
   * @param folders - Available folder names for the folder filter
   * @param excludedFolders - Folders to exclude from results (Trash, Spam, Drafts)
   * @param baselineFilters - Filters extracted from the original user query by intent
   *                          extraction. These are merged with each variant's rewriter-
   *                          generated filters so user-specified filters are always
   *                          preserved even when the LLM rewriter drops them. Variant
   *                          filters override baseline (allows refinement).
   * @returns VariantSearchResult for the first relevant variant, or null if all fail
   */
  async search(
    question: string,
    conversationHistory: ConversationTurn[],
    accountId: number,
    signal?: AbortSignal,
    todayDate?: string,
    userEmail?: string,
    folders?: string[],
    excludedFolders?: string[],
    baselineFilters?: SemanticSearchFilters,
  ): Promise<VariantSearchResult | null> {
    // ── Phase 1: Rewrite question into multiple search variants ───────────────
    const variants = await this.rewriteVariantsWithFallback(
      question, conversationHistory, signal, todayDate, userEmail, folders, baselineFilters,
    );
    if (signal?.aborted) {
      return null;
    }

    // ── Phase 2: Batch-embed all unique query strings ─────────────────────────
    const embeddingMap = await this.buildEmbeddingMap(variants, signal);
    if (signal?.aborted) {
      return null;
    }

    // ── Phase 3: Iterate variants, stopping at the first successful one ───────
    const lastVariantIndex = variants.length - 1;
    const processedVariantKeys = new Set<string>();
    let cachedResult: VariantSearchResult | null = null;

    for (let index = 0; index < variants.length; index++) {
      if (signal?.aborted) {
        return null;
      }

      const rawVariant = variants[index];

      // Merge baseline filters with the variant's own filters. Baseline provides
      // the user's original intent filters; variant filters can refine/override.
      const effectiveFilters: SemanticSearchFilters = {
        ...baselineFilters,
        ...rawVariant.filters,
      };
      const variant: RewriteResult = {
        ...rawVariant,
        filters: effectiveFilters,
      };

      // Skip duplicate variants (except the last one, which always runs)
      const variantKey = JSON.stringify({ query: variant.query, filters: variant.filters });
      if (index < lastVariantIndex && processedVariantKeys.has(variantKey)) {
        log.debug(`[VariantSearch] Variant ${index} is duplicate, skipping`, { query: variant.query });
        continue;
      }
      processedVariantKeys.add(variantKey);

      const embedding = embeddingMap.get(variant.query);
      if (!embedding) {
        log.warn(`[VariantSearch] Variant ${index} has no embedding, skipping`, { query: variant.query });
        continue;
      }

      log.debug(`[VariantSearch] Processing variant ${index}:`, {
        query: variant.query,
        filters: variant.filters,
        dateOrder: variant.dateOrder,
      });

      // ── Vector search + DB filter ──────────────────────────────────────────
      const filteredChunks = this.filterVariantChunks(variant, embedding, accountId, index);

      // ── Folder exclusion (applied inside the variant loop) ─────────────────
      const folderExcludedChunks = this.applyFolderExclusion(filteredChunks, accountId, excludedFolders, index);

      // ── Collect allMsgIds BEFORE the 15-chunk cap ──────────────────────────
      const allMsgIds = [...new Set(folderExcludedChunks.map(chunk => chunk.xGmMsgId))];

      if (folderExcludedChunks.length === 0) {
        if (index < lastVariantIndex) {
          log.debug(`[VariantSearch] Variant ${index} produced 0 chunks after filtering, skipping`);
          continue;
        }

        // Last variant with 0 chunks — fall back to cached result if available
        if (cachedResult !== null) {
          log.debug(`[VariantSearch] Variant ${index} (last) produced 0 chunks, falling back to cached result`);
          return cachedResult;
        }

        return null;
      }

      // ── Sort, cap, enrich, build context ───────────────────────────────────
      const variantResult = this.prepareVariantResult(folderExcludedChunks, variant, accountId, index, allMsgIds);

      if (signal?.aborted) {
        return null;
      }

      // ── Relevance check (skip for last variant) ────────────────────────────
      if (index < lastVariantIndex) {
        const isRelevant = await this.isVariantRelevant(
          index, variant, question, conversationHistory, variantResult.contextString, signal,
        );

        if (!isRelevant) {
          log.debug(`[VariantSearch] Variant ${index} failed relevance check, skipping`, { query: variant.query });
          continue;
        }

        log.info(`[VariantSearch] Variant ${index} passed relevance check`, { query: variant.query });

        if (cachedResult === null) {
          cachedResult = variantResult;
          log.debug(`[VariantSearch] Cached result from variant ${index} (first relevance-passing result)`);
        }

        return variantResult;
      }

      // Last variant — skip relevance check, proceed directly
      log.info(`[VariantSearch] Variant ${index} (last): skipping relevance check, using directly`);
      if (cachedResult === null) {
        cachedResult = variantResult;
      }

      return variantResult;
    }

    // All variants exhausted — return cached result or null
    log.info('[VariantSearch] All variants exhausted, no relevant results found');
    return cachedResult;
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Calls the multi-query rewriter and returns 5 ranked variants.
   * On abort the error is rethrown. On any other failure, logs and returns
   * 5 copies of the raw question as a fallback.
   *
   * When `baselineFilters` is provided, it is passed to the rewriter prompt
   * so the LLM knows about required filters, and is used as the fallback
   * filter set when the rewriter call fails entirely.
   */
  private async rewriteVariantsWithFallback(
    question: string,
    conversationHistory: ConversationTurn[],
    signal?: AbortSignal,
    todayDate?: string,
    userEmail?: string,
    folders?: string[],
    baselineFilters?: SemanticSearchFilters,
  ): Promise<RewriteResult[]> {
    try {
      const variants = await this.rewriteMultiQuery(
        question, conversationHistory, signal, todayDate, userEmail, folders, baselineFilters,
      );
      log.info('[VariantSearch] Multi-query rewrite produced variants:', {
        count: variants.length,
        queries: variants.map((variant, index) => ({ index, query: variant.query })),
      });
      return variants;
    } catch (rewriteError) {
      if (signal?.aborted) {
        throw rewriteError;
      }
      log.warn('[VariantSearch] Query rewriting failed, falling back to raw question for all slots:', rewriteError);
      const fallbackVariant: RewriteResult = { query: question, filters: baselineFilters ?? {}, dateOrder: 'desc' };
      return Array.from({ length: 5 }, () => ({ ...fallbackVariant }));
    }
  }

  /**
   * Calls the multi-query rewriter LLM to produce 5 ranked RewriteResult variants.
   * Replaces {{FOLDERS}}, {{USER_EMAIL}}, and {{BASELINE_FILTERS}} placeholders in the prompt.
   */
  private async rewriteMultiQuery(
    question: string,
    history: ConversationTurn[],
    signal?: AbortSignal,
    todayDate?: string,
    userEmail?: string,
    folders?: string[],
    baselineFilters?: SemanticSearchFilters,
  ): Promise<RewriteResult[]> {
    const resolvedTodayDate = todayDate ?? (DateTime.now().toLocal().toISODate() ?? '');
    const resolvedUserEmail = userEmail ?? '';
    const resolvedFolders = folders ? folders.join(', ') : '';
    const resolvedBaselineFilters = baselineFilters && hasFilters(baselineFilters)
      ? JSON.stringify(baselineFilters)
      : '{}';

    const rawPrompt = loadPrompt('inbox-chat-rewrite-multi-query', {
      'TODAY_DATE': resolvedTodayDate,
      'USER_EMAIL': resolvedUserEmail,
      'FOLDERS': resolvedFolders,
      'BASELINE_FILTERS': resolvedBaselineFilters,
    });

    const historyText = history
      .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
      .join('\n');
    const conversationLabel = history.length > 0 ? `Conversation:\n${historyText}\n` : 'Conversation: (empty)\n';
    const userMessage = `${conversationLabel}New question: ${question}`;

    const rawResult = await this.ollama.chat(
      [
        { role: 'system', content: rawPrompt },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0.3, numPredict: 1200, format: 'json', signal },
    );

    return this.parseMultiQueryResult(rawResult, question);
  }

  /**
   * Parses the raw LLM output into an array of exactly 5 RewriteResult objects.
   *
   * Handles:
   * - Top-level JSON arrays
   * - Wrapped-object arrays (e.g. `{ "queries": [...] }`)
   * - Padding to 5 when fewer valid items returned
   * - Boolean coercion for string "true"/"false" on boolean fields
   */
  private parseMultiQueryResult(rawOutput: string, originalQuestion: string): RewriteResult[] {
    const fallback: RewriteResult = { query: originalQuestion, filters: {}, dateOrder: 'desc' };
    const trimmed = rawOutput.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (parseError) {
      log.warn('[VariantSearch] rewriteMultiQuery JSON parse failed, padding with fallbacks:', {
        rawOutput: trimmed.slice(0, 200),
        parseError,
      });
      return Array.from({ length: 5 }, () => ({ ...fallback }));
    }

    // Resolve the candidate array from the parsed value
    let candidateArray: unknown[];

    if (Array.isArray(parsed)) {
      candidateArray = parsed;
    } else if (typeof parsed === 'object' && parsed !== null) {
      const wrappedArray = Object.values(parsed as Record<string, unknown>).find(
        value => Array.isArray(value),
      );
      if (Array.isArray(wrappedArray)) {
        candidateArray = wrappedArray;
        log.debug('[VariantSearch] rewriteMultiQuery: unwrapped nested array from object response');
      } else {
        log.warn('[VariantSearch] rewriteMultiQuery: parsed object has no array property, padding with fallbacks:', { parsed });
        return Array.from({ length: 5 }, () => ({ ...fallback }));
      }
    } else {
      log.warn('[VariantSearch] rewriteMultiQuery: unexpected parsed type, padding with fallbacks:', {
        type: typeof parsed,
      });
      return Array.from({ length: 5 }, () => ({ ...fallback }));
    }

    // Validate and convert each candidate element
    const validResults: RewriteResult[] = [];
    for (const candidate of candidateArray) {
      if (!this.isValidRewriteResponse(candidate)) {
        log.debug('[VariantSearch] rewriteMultiQuery: skipping invalid array element:', { candidate });
        continue;
      }

      const filters: SemanticSearchFilters = {};

      if (typeof candidate.dateFrom === 'string' && candidate.dateFrom.length > 0) {
        filters.dateFrom = candidate.dateFrom;
      }

      if (typeof candidate.dateTo === 'string' && candidate.dateTo.length > 0) {
        filters.dateTo = candidate.dateTo;
      }

      if (typeof candidate.sender === 'string' && candidate.sender.length > 0) {
        filters.sender = candidate.sender;
      }

      if (typeof candidate.recipient === 'string' && candidate.recipient.length > 0) {
        filters.recipient = candidate.recipient;
      }

      if (typeof candidate.folder === 'string' && candidate.folder.length > 0) {
        filters.folder = candidate.folder;
      }

      // Coerce string "true"/"false" to actual booleans for boolean fields
      const hasAttachmentValue = this.coerceToBoolean(candidate.hasAttachment);
      if (hasAttachmentValue !== undefined) {
        filters.hasAttachment = hasAttachmentValue;
      }

      const isReadValue = this.coerceToBoolean(candidate.isRead);
      if (isReadValue !== undefined) {
        filters.isRead = isReadValue;
      }

      const isStarredValue = this.coerceToBoolean(candidate.isStarred);
      if (isStarredValue !== undefined) {
        filters.isStarred = isStarredValue;
      }

      const dateOrder: 'asc' | 'desc' = candidate.dateOrder === 'asc' ? 'asc' : 'desc';

      validResults.push({
        query: candidate.query || originalQuestion,
        filters,
        dateOrder,
      });

      // Stop once we have 5
      if (validResults.length === 5) {
        break;
      }
    }

    // Pad up to exactly 5
    while (validResults.length < 5) {
      validResults.push({ ...fallback });
    }

    log.info('[VariantSearch] rewriteMultiQuery parsed variants:', {
      validCount: validResults.length,
      candidateCount: candidateArray.length,
      firstQuery: validResults[0].query,
    });

    return validResults;
  }

  /**
   * Coerces a value to a boolean. Handles actual booleans and string
   * representations "true"/"false". Returns undefined for null, undefined,
   * or unrecognized values.
   */
  private coerceToBoolean(value: unknown): boolean | undefined {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (value.toLowerCase() === 'true') {
        return true;
      }
      if (value.toLowerCase() === 'false') {
        return false;
      }
    }
    return undefined;
  }

  /**
   * Type guard that checks the parsed JSON object has the minimum required
   * shape for a rewrite response.
   *
   * `query` must be a string. String filter fields (dateFrom, dateTo, sender,
   * recipient, folder, dateOrder), if present, must be strings. Boolean filter
   * fields (hasAttachment, isRead, isStarred), if present, must be booleans or
   * strings (coerced later). Null values are accepted for all optional fields.
   */
  private isValidRewriteResponse(value: unknown): value is {
    query: string;
    dateFrom?: string;
    dateTo?: string;
    sender?: string;
    recipient?: string;
    folder?: string;
    dateOrder?: string;
    hasAttachment?: boolean | string;
    isRead?: boolean | string;
    isStarred?: boolean | string;
  } {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Record<string, unknown>;

    if (typeof candidate['query'] !== 'string') {
      return false;
    }

    // Validate optional string fields
    const optionalStringFields = ['dateFrom', 'dateTo', 'sender', 'recipient', 'folder', 'dateOrder'] as const;
    for (const fieldName of optionalStringFields) {
      const fieldValue = candidate[fieldName];
      if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== 'string') {
        return false;
      }
    }

    // Validate optional boolean fields (accept booleans and strings for coercion)
    const optionalBooleanFields = ['hasAttachment', 'isRead', 'isStarred'] as const;
    for (const fieldName of optionalBooleanFields) {
      const fieldValue = candidate[fieldName];
      if (
        fieldValue !== undefined &&
        fieldValue !== null &&
        typeof fieldValue !== 'boolean' &&
        typeof fieldValue !== 'string'
      ) {
        return false;
      }
    }

    return true;
  }

  /**
   * Batch-embeds all unique query strings from the variants and returns a map
   * from query string → embedding vector.
   */
  private async buildEmbeddingMap(
    variants: RewriteResult[],
    signal?: AbortSignal,
  ): Promise<Map<string, number[]>> {
    const uniqueQueryStrings = [...new Set(variants.map(variant => variant.query))];
    log.debug('[VariantSearch] Batch-embedding unique query strings:', {
      totalVariants: variants.length,
      uniqueCount: uniqueQueryStrings.length,
      queries: uniqueQueryStrings,
    });

    const rawEmbeddings = await this.ollama.embed(uniqueQueryStrings, { signal });

    if (rawEmbeddings.length !== uniqueQueryStrings.length) {
      throw new Error(
        `Embed response length mismatch: expected ${uniqueQueryStrings.length}, got ${rawEmbeddings.length}`,
      );
    }
    for (let vectorIndex = 0; vectorIndex < rawEmbeddings.length; vectorIndex++) {
      const vector = rawEmbeddings[vectorIndex];
      if (!vector || vector.length === 0) {
        throw new Error(`Embed response invalid: vector at index ${vectorIndex} is empty`);
      }
    }

    const embeddingMap = new Map<string, number[]>();
    for (let index = 0; index < uniqueQueryStrings.length; index++) {
      embeddingMap.set(uniqueQueryStrings[index], rawEmbeddings[index]);
    }
    log.debug('[VariantSearch] Embeddings computed:', { mappedCount: embeddingMap.size });
    return embeddingMap;
  }

  /**
   * Runs a vector search for the variant's embedding then applies structured
   * DB filters (all 8 fields) and the similarity threshold.
   * Returns the filtered candidate chunks ready for folder exclusion and enrichment.
   *
   * CRITICAL: operates on a COPY of the filters for date normalization so the
   * original raw filters (YYYY-MM-DD) are preserved in the RewriteResult.
   */
  private filterVariantChunks(
    variant: RewriteResult,
    embedding: number[],
    accountId: number,
    variantIndex: number,
  ): VectorSearchResult[] {
    const candidateChunks = this.vectorDb.search(embedding, accountId, VECTOR_CANDIDATE_BUDGET);

    if (hasFilters(variant.filters)) {
      // Normalize local calendar date strings to UTC ISO bounds on a COPY
      const normalizedFilters = this.normalizeFilterDates(variant.filters);
      const uniqueMsgIds = [...new Set(candidateChunks.map(chunk => chunk.xGmMsgId))];
      const filterResult = this.db.filterEmailsByMsgIds(
        accountId,
        uniqueMsgIds,
        normalizedFilters,
      );
      // Treat uncertain (All-Mail-only) candidates as passed — they'll be
      // verified by IMAP later in filterAndResolve.
      const passedMsgIds = new Set([...filterResult.matched, ...filterResult.uncertain]);
      const filteredChunks = candidateChunks
        .filter(chunk => passedMsgIds.has(chunk.xGmMsgId))
        .filter(chunk => chunk.similarity >= SIMILARITY_THRESHOLD);
      log.debug(`[VariantSearch] Variant ${variantIndex} DB filter + similarity applied:`, {
        candidateCount: candidateChunks.length,
        afterFilter: filteredChunks.length,
        filters: normalizedFilters,
      });
      return filteredChunks;
    }

    // Semantic-only: apply similarity threshold
    const filteredChunks = candidateChunks.filter(chunk => chunk.similarity >= SIMILARITY_THRESHOLD);
    log.debug(`[VariantSearch] Variant ${variantIndex} similarity filter applied:`, {
      candidateCount: candidateChunks.length,
      afterFilter: filteredChunks.length,
    });
    return filteredChunks;
  }

  /**
   * Applies folder exclusion filtering to chunks. Only applied when
   * excludedFolders is provided (non-empty).
   */
  private applyFolderExclusion(
    chunks: VectorSearchResult[],
    accountId: number,
    excludedFolders?: string[],
    variantIndex?: number,
  ): VectorSearchResult[] {
    if (!excludedFolders || excludedFolders.length === 0) {
      return chunks;
    }

    const uniqueMsgIds = [...new Set(chunks.map(chunk => chunk.xGmMsgId))];
    const allowedMsgIds = new Set(
      BaseSearchService.filterExcludedFolders(this.db, accountId, uniqueMsgIds, excludedFolders),
    );

    const filtered = chunks.filter(chunk => allowedMsgIds.has(chunk.xGmMsgId));
    log.debug(`[VariantSearch] Variant ${variantIndex ?? '?'} folder exclusion applied:`, {
      beforeCount: chunks.length,
      afterCount: filtered.length,
      excludedFolders,
    });
    return filtered;
  }

  /**
   * Sorts chunks, caps at FINAL_CHUNK_LIMIT, enriches with email metadata,
   * and builds the context string. Returns a VariantSearchResult.
   *
   * @param allMsgIds - All unique message IDs from the filtered chunks (BEFORE cap)
   */
  private prepareVariantResult(
    filteredChunks: VectorSearchResult[],
    variant: RewriteResult,
    accountId: number,
    variantIndex: number,
    allMsgIds: string[],
  ): VariantSearchResult {
    // Sort by date, falling back to similarity score
    const chunkMsgIds = [...new Set(filteredChunks.map(chunk => chunk.xGmMsgId))];
    const dateMap = this.db.getEmailDatesByMsgIds(accountId, chunkMsgIds);
    filteredChunks.sort((chunkA, chunkB) => {
      const dateA = dateMap.get(chunkA.xGmMsgId);
      const dateB = dateMap.get(chunkB.xGmMsgId);
      if (!dateA && !dateB) { return chunkB.similarity - chunkA.similarity; }
      if (!dateA) { return 1; }
      if (!dateB) { return -1; }
      const dateCmp = variant.dateOrder === 'asc'
        ? dateA.localeCompare(dateB)
        : dateB.localeCompare(dateA);
      return dateCmp !== 0 ? dateCmp : chunkB.similarity - chunkA.similarity;
    });

    const cappedChunks = filteredChunks.slice(0, FINAL_CHUNK_LIMIT);
    const enrichedChunks = this.enrichChunks(cappedChunks, accountId);
    const contextString = this.buildContextString(enrichedChunks);

    log.debug(`[VariantSearch] Variant ${variantIndex} prepared:`, {
      totalChunks: filteredChunks.length,
      cappedChunks: cappedChunks.length,
      enrichedChunks: enrichedChunks.length,
      allMsgIds: allMsgIds.length,
    });

    return {
      enrichedChunks,
      contextString,
      allMsgIds,
      filters: variant.filters,
    };
  }

  /**
   * Enriches raw vector search chunks with email metadata from the database.
   */
  private enrichChunks(
    chunks: Array<{ xGmMsgId: string; chunkText: string; similarity: number }>,
    accountId: number,
  ): EnrichedChunk[] {
    const uniqueMsgIds = [...new Set(chunks.map(chunk => chunk.xGmMsgId))];
    const emailMetadata = new Map<string, {
      fromName: string;
      fromAddress: string;
      toAddresses: string;
      subject: string;
      date: string;
    }>();

    for (const xGmMsgId of uniqueMsgIds) {
      const row = this.db.getEmailByXGmMsgId(accountId, xGmMsgId);
      if (row) {
        emailMetadata.set(xGmMsgId, {
          fromName: String(row['fromName'] ?? row['fromAddress'] ?? 'Unknown'),
          fromAddress: String(row['fromAddress'] ?? ''),
          toAddresses: String(row['toAddresses'] ?? ''),
          subject: String(row['subject'] ?? '(No subject)'),
          date: String(row['date'] ?? ''),
        });
      }
    }

    const firstChunkSeen = new Set<string>();
    return chunks.map(chunk => {
      const meta = emailMetadata.get(chunk.xGmMsgId);
      const isFirstChunk = !firstChunkSeen.has(chunk.xGmMsgId);
      if (isFirstChunk) {
        firstChunkSeen.add(chunk.xGmMsgId);
      }

      const fromName = meta?.fromName ?? 'Unknown';
      const fromAddress = meta?.fromAddress ?? '';
      const toAddresses = meta?.toAddresses ?? '';
      const subject = meta?.subject ?? '(No subject)';
      const date = meta?.date ?? '';

      let formattedDate: string;
      if (date) {
        const parsedDateTime = DateTime.fromISO(date);
        formattedDate = parsedDateTime.isValid
          ? parsedDateTime.toLocaleString({ month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
          : date;
      } else {
        formattedDate = '';
      }

      return {
        xGmMsgId: chunk.xGmMsgId,
        fromName,
        fromAddress,
        toAddresses,
        subject,
        date,
        chunkText: isFirstChunk
          ? `From: ${fromName} <${fromAddress}>\nTo: ${toAddresses}\nSubject: ${subject}\nDate: ${formattedDate}\n${chunk.chunkText}`
          : chunk.chunkText,
      };
    });
  }

  /**
   * Builds a numbered context string from enriched chunks for the LLM.
   */
  private buildContextString(enrichedChunks: EnrichedChunk[]): string {
    return enrichedChunks
      .map((chunk, index) => `[${index + 1}] ${chunk.chunkText}`)
      .join('\n\n---\n\n');
  }

  /**
   * Assesses whether the retrieved email chunks are relevant to the user's question.
   * Uses the relevance-check prompt.
   *
   * Returns true (conservatively) if the check fails or parsing fails.
   */
  private async isVariantRelevant(
    variantIndex: number,
    variant: RewriteResult,
    question: string,
    conversationHistory: ConversationTurn[],
    contextString: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      return await this.checkRelevance(question, conversationHistory, contextString, signal);
    } catch (relevanceError) {
      if (signal?.aborted) {
        throw relevanceError;
      }
      log.warn(`[VariantSearch] Variant ${variantIndex} relevance check threw unexpectedly, treating as relevant:`, relevanceError);
      return true;
    }
  }

  /**
   * Calls the LLM relevance-check prompt to determine if retrieved context
   * is relevant to the question.
   */
  private async checkRelevance(
    question: string,
    conversationHistory: ConversationTurn[],
    contextString: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const systemPrompt = loadPrompt('inbox-chat-relevance-check');

    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: systemPrompt },
    ];

    for (const turn of conversationHistory) {
      messages.push({ role: turn.role, content: turn.content });
    }

    messages.push({
      role: 'user',
      content: `## Email Context\n\n${contextString}\n\n## Question\n\n${question}`,
    });

    let rawResult: string;
    try {
      rawResult = await this.ollama.chat(messages, {
        temperature: 0.3,
        numPredict: 50,
        format: 'json',
        signal,
      });
    } catch (callError) {
      if (signal?.aborted) {
        throw callError;
      }
      log.warn('[VariantSearch] checkRelevance: LLM call failed, defaulting to relevant=true:', callError);
      return true;
    }

    try {
      const parsed: unknown = JSON.parse(rawResult.trim());
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        'relevant' in parsed &&
        typeof (parsed as Record<string, unknown>)['relevant'] === 'boolean'
      ) {
        return (parsed as Record<string, unknown>)['relevant'] as boolean;
      }

      log.warn('[VariantSearch] checkRelevance: missing or non-boolean "relevant" field, defaulting to true:', {
        rawResult: rawResult.slice(0, 200),
      });
      return true;
    } catch (parseError) {
      log.warn('[VariantSearch] checkRelevance: JSON parse failed, defaulting to relevant=true:', {
        rawResult: rawResult.slice(0, 200),
        parseError,
      });
      return true;
    }
  }

  /**
   * Normalizes local calendar date strings in a SemanticSearchFilters object to
   * UTC ISO timestamp bounds for DB comparison.
   *
   * CRITICAL: operates on a COPY of the filters — does NOT mutate the original.
   *
   * - `dateFrom` ("YYYY-MM-DD") → start of that local calendar day in UTC
   * - `dateTo`   ("YYYY-MM-DD") → start of the NEXT local calendar day in UTC (exclusive upper bound)
   */
  private normalizeFilterDates(filters: SemanticSearchFilters): SemanticSearchFilters {
    const normalized: SemanticSearchFilters = { ...filters };

    if (filters.dateFrom !== undefined) {
      const utcFrom = this.localCalendarDateToUtcIso(filters.dateFrom, false);
      if (utcFrom !== null) {
        normalized.dateFrom = utcFrom;
      } else {
        delete normalized.dateFrom;
        log.warn('[VariantSearch] normalizeFilterDates: invalid dateFrom string, filter dropped:', filters.dateFrom);
      }
    }

    if (filters.dateTo !== undefined) {
      const utcTo = this.localCalendarDateToUtcIso(filters.dateTo, true);
      if (utcTo !== null) {
        normalized.dateTo = utcTo;
      } else {
        delete normalized.dateTo;
        log.warn('[VariantSearch] normalizeFilterDates: invalid dateTo string, filter dropped:', filters.dateTo);
      }
    }

    return normalized;
  }

  /**
   * Converts a local calendar date string ("YYYY-MM-DD") to a UTC ISO timestamp.
   *
   * @param dateString - Local calendar date in "YYYY-MM-DD" format
   * @param nextDay    - If true, returns the start of the NEXT calendar day (for exclusive upper bounds)
   * @returns UTC ISO string, or null if the date string is invalid
   */
  private localCalendarDateToUtcIso(dateString: string, nextDay: boolean): string | null {
    const localDate = DateTime.fromFormat(dateString, 'yyyy-MM-dd', { zone: 'local' });

    if (!localDate.isValid) {
      return null;
    }

    const targetDate = nextDay ? localDate.plus({ days: 1 }) : localDate;
    return targetDate.toUTC().toISO() ?? null;
  }
}
