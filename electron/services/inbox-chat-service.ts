import * as path from 'path';
import * as fs from 'fs';
import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { OllamaService } from './ollama-service';
import { VectorDbService, VectorSearchResult } from './vector-db-service';
import { SemanticSearchFilters } from '../utils/search-filter-translator';

const log = LoggerService.getInstance();

interface EnrichedChunk {
  xGmMsgId: string;
  fromName: string;
  fromAddress: string;
  toAddresses: string;
  subject: string;
  date: string;
  chunkText: string;
}

interface ConversationTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface SourceEmail {
  xGmMsgId: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  date: string;
  citationIndex: number;  // The [N] number used to cite this email in the response
}

export interface ChatStreamCallbacks {
  onToken: (token: string) => void;
  onSources: (sources: SourceEmail[]) => void;
  onDone: (cancelled: boolean, error?: string) => void;
}

/** Maximum number of vector search candidate chunks when no filters are present. */
const VECTOR_CANDIDATE_BUDGET = 1360;

/**
 * Minimum cosine similarity score for a chunk to be considered relevant when
 * no structured filters are present. When DB filters (date/sender/recipient) are
 * active the threshold is not applied — the filters themselves narrow the candidate
 * set so relevance is determined by DB match + similarity rank order.
 */
const SIMILARITY_THRESHOLD = 0.5;

/** Maximum number of chunks to pass to the LLM after all filtering is applied. */
const FINAL_CHUNK_LIMIT = 15;

/** Structured result returned by rewriteQuery(). */
interface RewriteResult {
  query: string;
  filters: SemanticSearchFilters;
  /** Sort direction for results. Defaults to 'desc' (newest first). */
  dateOrder: 'asc' | 'desc';
}

/** Enriched chunks and the formatted context string built from a single variant. */
interface VariantContext {
  enrichedChunks: EnrichedChunk[];
  contextString: string;
}

/** Result returned by streamVariantAnswer(). */
interface StreamResult {
  aborted: boolean;
  error: string | undefined;
  accumulatedResponse: string;
}

interface VariantExecutionState {
  processedVariantKeys: Set<string>;
  cachedContext: VariantContext | null;
  lastVariantIndex: number;
}

interface VariantExecutionResult {
  completed: boolean;
  cachedContext: VariantContext | null;
}

export class InboxChatService {
  private activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly ollamaService: OllamaService,
    private readonly vectorDbService: VectorDbService,
  ) {}

  async chat(
    requestId: string,
    question: string,
    conversationHistory: ConversationTurn[],
    accountId: number,
    accountEmail: string,
    callbacks: ChatStreamCallbacks,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(requestId, controller);

    try {
      // ── Phase 1: Rewrite question into multiple search variants ───────────────
      const variants = await this.rewriteVariantsWithFallback(question, conversationHistory, controller.signal);
      if (this.handleAbort(controller.signal, callbacks)) {
        return;
      }

      // ── Phase 2: Batch-embed all unique query strings ─────────────────────────
      const embeddingMap = await this.buildEmbeddingMap(variants, controller.signal);
      if (this.handleAbort(controller.signal, callbacks)) {
        return;
      }

      // ── Phase 3: Build the system prompt (static for this entire request) ─────
      const systemPrompt = this.buildSystemPrompt(accountEmail);

      // ── Phase 4: Iterate variants, stopping at the first successful synthesis ─
      const executionState: VariantExecutionState = {
        processedVariantKeys: new Set<string>(),
        cachedContext: null,
        lastVariantIndex: variants.length - 1,
      };

      for (let index = 0; index < variants.length; index++) {
        const variantResult = await this.executeVariant(
          variants[index],
          index,
          executionState,
          embeddingMap,
          accountId,
          question,
          conversationHistory,
          systemPrompt,
          controller,
          requestId,
          callbacks,
        );

        executionState.cachedContext = variantResult.cachedContext;
        if (variantResult.completed) {
          return;
        }

        if (this.handleAbort(controller.signal, callbacks)) {
          return;
        }
      }

      // ── All variants exhausted — no relevant emails found ─────────────────────
      log.info('[chat] All variants exhausted, no relevant emails found');
      callbacks.onToken(
        "I couldn't find any emails that match what you're looking for. " +
        'Try rephrasing your question, or ask about a different topic. If you just added mail, give sync a moment to finish.'
      );
      callbacks.onSources([]);
      callbacks.onDone(false);
    } catch (error) {
      if (controller.signal.aborted) {
        callbacks.onDone(true);
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('[chat] Chat pipeline error:', error);
      callbacks.onDone(false, errorMessage);
    } finally {
      this.activeControllers.delete(requestId);
    }
  }

  cancel(requestId: string): void {
    const controller = this.activeControllers.get(requestId);
    if (controller) {
      controller.abort();
      log.info('[InboxChatService] Cancelled chat request:', requestId);
    }
  }

  // ── Private helpers for chat() ─────────────────────────────────────────────

  private handleAbort(signal: AbortSignal, callbacks: ChatStreamCallbacks): boolean {
    if (signal.aborted) {
      callbacks.onDone(true);
      return true;
    }

    return false;
  }

  private async executeVariant(
    variant: RewriteResult,
    variantIndex: number,
    state: VariantExecutionState,
    embeddingMap: Map<string, number[]>,
    accountId: number,
    question: string,
    conversationHistory: ConversationTurn[],
    systemPrompt: string,
    controller: AbortController,
    requestId: string,
    callbacks: ChatStreamCallbacks,
  ): Promise<VariantExecutionResult> {
    if (this.handleAbort(controller.signal, callbacks)) {
      return { completed: true, cachedContext: state.cachedContext };
    }

    if (this.shouldSkipDuplicateVariant(variant, variantIndex, state)) {
      return { completed: false, cachedContext: state.cachedContext };
    }

    const embedding = embeddingMap.get(variant.query);
    if (!embedding) {
      log.warn(`[chat] Variant ${variantIndex} has no embedding, skipping`, { query: variant.query });
      return { completed: false, cachedContext: state.cachedContext };
    }

    log.debug(`[chat] Processing variant ${variantIndex}:`, {
      query: variant.query,
      filters: variant.filters,
      dateOrder: variant.dateOrder,
    });

    const filteredChunks = this.filterVariantChunks(variant, embedding, accountId, variantIndex);
    const variantContext = this.buildVariantContextForExecution(filteredChunks, variant, accountId, variantIndex, state.cachedContext, state.lastVariantIndex);

    if (variantContext === null) {
      return { completed: false, cachedContext: state.cachedContext };
    }

    if (this.handleAbort(controller.signal, callbacks)) {
      return { completed: true, cachedContext: state.cachedContext };
    }

    const cacheOutcome = await this.evaluateVariantForSynthesis(
      variant,
      variantIndex,
      variantContext,
      question,
      conversationHistory,
      controller.signal,
      state.cachedContext,
      state.lastVariantIndex,
    );

    if (!cacheOutcome.shouldProceed) {
      return { completed: false, cachedContext: cacheOutcome.cachedContext };
    }

    const streamCompleted = await this.streamVariantSynthesis(
      variantContext,
      variantIndex,
      systemPrompt,
      conversationHistory,
      question,
      controller,
      requestId,
      callbacks,
    );

    return { completed: streamCompleted, cachedContext: cacheOutcome.cachedContext };
  }

  private shouldSkipDuplicateVariant(
    variant: RewriteResult,
    variantIndex: number,
    state: VariantExecutionState,
  ): boolean {
    const variantKey = JSON.stringify({ query: variant.query, filters: variant.filters });
    if (variantIndex < state.lastVariantIndex && state.processedVariantKeys.has(variantKey)) {
      log.debug(`[chat] Variant ${variantIndex} is duplicate, skipping`, { query: variant.query });
      return true;
    }

    state.processedVariantKeys.add(variantKey);
    return false;
  }

  private buildVariantContextForExecution(
    filteredChunks: VectorSearchResult[],
    variant: RewriteResult,
    accountId: number,
    variantIndex: number,
    cachedContext: VariantContext | null,
    lastVariantIndex: number,
  ): VariantContext | null {
    if (filteredChunks.length === 0) {
      if (variantIndex < lastVariantIndex) {
        log.debug(`[chat] Variant ${variantIndex} produced 0 chunks after filtering, skipping`);
        return null;
      }

      if (cachedContext !== null) {
        log.debug(`[chat] Variant ${variantIndex} (last) produced 0 chunks, falling back to cached context`);
        return cachedContext;
      }

      return null;
    }

    return this.prepareVariantContext(filteredChunks, variant, accountId, variantIndex);
  }

  private async evaluateVariantForSynthesis(
    variant: RewriteResult,
    variantIndex: number,
    variantContext: VariantContext,
    question: string,
    conversationHistory: ConversationTurn[],
    signal: AbortSignal,
    cachedContext: VariantContext | null,
    lastVariantIndex: number,
  ): Promise<{ shouldProceed: boolean; cachedContext: VariantContext | null }> {
    if (variantIndex < lastVariantIndex) {
      const isRelevant = await this.isVariantRelevant(
        variantIndex,
        variant,
        question,
        conversationHistory,
        variantContext.contextString,
        signal,
      );

      if (!isRelevant) {
        log.debug(`[chat] Variant ${variantIndex} failed relevance check, skipping`, { query: variant.query });
        return { shouldProceed: false, cachedContext };
      }

      log.info(`[chat] Variant ${variantIndex} passed relevance check, proceeding to synthesis`, { query: variant.query });

      if (cachedContext === null) {
        cachedContext = variantContext;
        log.debug(`[chat] Cached context from variant ${variantIndex} (first relevance-passing result)`);
      }

      return { shouldProceed: true, cachedContext };
    }

    log.info(`[chat] Variant ${variantIndex} (last): skipping relevance check, proceeding directly to synthesis`);
    if (cachedContext === null) {
      cachedContext = variantContext;
      log.debug(`[chat] Cached context from variant ${variantIndex} (proceeding to synthesis)`);
    }

    return { shouldProceed: true, cachedContext };
  }

  private async isVariantRelevant(
    variantIndex: number,
    variant: RewriteResult,
    question: string,
    conversationHistory: ConversationTurn[],
    contextString: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    try {
      return await this.checkRelevance(question, conversationHistory, contextString, signal);
    } catch (relevanceError) {
      if (signal.aborted) {
        throw relevanceError;
      }

      log.warn(`[chat] Variant ${variantIndex} relevance check threw unexpectedly, treating as relevant:`, relevanceError);
      return true;
    }
  }

  private async streamVariantSynthesis(
    variantContext: VariantContext,
    variantIndex: number,
    systemPrompt: string,
    conversationHistory: ConversationTurn[],
    question: string,
    controller: AbortController,
    requestId: string,
    callbacks: ChatStreamCallbacks,
  ): Promise<boolean> {
    log.debug(`[chat] Variant ${variantIndex}: beginning synthesis`);
    const messages = this.buildMessages(systemPrompt, variantContext.contextString, conversationHistory, question);
    const streamResult = await this.streamVariantAnswer(messages, controller, requestId, variantIndex, callbacks);

    if (streamResult.aborted || streamResult.error !== undefined) {
      callbacks.onSources([]);
      callbacks.onDone(streamResult.aborted, streamResult.error);
      return true;
    }

    const citedSources = this.parseCitedSources(streamResult.accumulatedResponse, variantContext.enrichedChunks);
    callbacks.onSources(citedSources);
    callbacks.onDone(false);
    log.debug(`[chat] Variant ${variantIndex} answer streamed successfully`);
    return true;
  }

  /**
   * Calls the multi-query rewriter and returns 5 ranked variants.
   * On abort the error is rethrown (outer catch handles it). On any other
   * failure, logs and returns 5 copies of the raw question as a fallback so
   * the pipeline can still attempt a synthesis.
   */
  private async rewriteVariantsWithFallback(
    question: string,
    conversationHistory: ConversationTurn[],
    signal: AbortSignal,
  ): Promise<RewriteResult[]> {
    try {
      const variants = await this.rewriteMultiQuery(question, conversationHistory, signal);
      log.info('[chat] Multi-query rewrite produced variants:', {
        count: variants.length,
        queries: variants.map((variant, index) => ({ index, query: variant.query })),
      });
      return variants;
    } catch (rewriteError) {
      if (signal.aborted) {
        throw rewriteError;
      }
      log.warn('[chat] Query rewriting failed, falling back to raw question for all slots:', rewriteError);
      const fallbackVariant: RewriteResult = { query: question, filters: {}, dateOrder: 'desc' };
      return Array.from({ length: 5 }, () => ({ ...fallbackVariant }));
    }
  }

  /**
   * Batch-embeds all unique query strings from the variants and returns a map
   * from query string → embedding vector.
   *
   * Validates a strict 1:1 mapping: throws if Ollama returns the wrong number
   * of vectors or any vector is empty. Errors propagate to the outer catch in
   * chat() which handles both abort and fatal pipeline errors.
   */
  private async buildEmbeddingMap(
    variants: RewriteResult[],
    signal: AbortSignal,
  ): Promise<Map<string, number[]>> {
    const uniqueQueryStrings = [...new Set(variants.map(variant => variant.query))];
    log.debug('[chat] Batch-embedding unique query strings:', {
      totalVariants: variants.length,
      uniqueCount: uniqueQueryStrings.length,
      queries: uniqueQueryStrings,
    });

    const rawEmbeddings = await this.ollamaService.embed(uniqueQueryStrings, { signal });

    if (rawEmbeddings.length !== uniqueQueryStrings.length) {
      throw new Error(
        `Embed response length mismatch: expected ${uniqueQueryStrings.length}, got ${rawEmbeddings.length}`
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
    log.debug('[chat] Embeddings computed:', { mappedCount: embeddingMap.size });
    return embeddingMap;
  }

  /**
   * Loads the inbox-chat system prompt and injects the current datetime and
   * the account email address. The result is static for the lifetime of a
   * single chat() request.
   */
  private buildSystemPrompt(accountEmail: string): string {
    const currentDateTimeFormatted = DateTime.now().toLocaleString({
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    const rawSystemPrompt = this.loadPrompt('inbox-chat-system.md');
    return rawSystemPrompt
      .split('{{CURRENT_DATETIME}}').join(currentDateTimeFormatted)
      .split('{{USER_EMAIL}}').join(accountEmail);
  }

  /**
   * Runs a vector search for the variant's embedding then applies structured
   * DB filters (date / sender / recipient) and the similarity threshold.
   * Returns the filtered candidate chunks ready for enrichment.
   */
  private filterVariantChunks(
    variant: RewriteResult,
    embedding: number[],
    accountId: number,
    variantIndex: number,
  ): VectorSearchResult[] {
    const candidateChunks = this.vectorDbService.search(embedding, accountId, VECTOR_CANDIDATE_BUDGET);

    const hasFilters =
      variant.filters.dateFrom !== undefined ||
      variant.filters.dateTo !== undefined ||
      variant.filters.sender !== undefined ||
      variant.filters.recipient !== undefined;

    if (hasFilters) {
      // Normalize local calendar date strings to UTC ISO bounds
      const normalizedFilters = this.normalizeFilterDates(variant.filters);
      const uniqueMsgIds = [...new Set(candidateChunks.map(chunk => chunk.xGmMsgId))];
      const matchingMsgIdSet = this.databaseService.filterEmailsByMsgIds(
        accountId,
        uniqueMsgIds,
        normalizedFilters,
      );
      const filteredChunks = candidateChunks
        .filter(chunk => matchingMsgIdSet.has(chunk.xGmMsgId))
        .filter(chunk => chunk.similarity >= SIMILARITY_THRESHOLD);
      log.debug(`[chat] Variant ${variantIndex} DB filter + similarity applied:`, {
        candidateCount: candidateChunks.length,
        afterFilter: filteredChunks.length,
        filters: normalizedFilters,
      });
      return filteredChunks;
    }

    // Semantic-only: apply similarity threshold
    const filteredChunks = candidateChunks.filter(chunk => chunk.similarity >= SIMILARITY_THRESHOLD);
    log.debug(`[chat] Variant ${variantIndex} similarity filter applied:`, {
      candidateCount: candidateChunks.length,
      afterFilter: filteredChunks.length,
    });
    return filteredChunks;
  }

  /**
   * Sorts chunks by the variant's preferred date order, caps at FINAL_CHUNK_LIMIT,
   * enriches them with email metadata, and builds the formatted context string.
   * Returns a VariantContext ready to pass to the relevance check and synthesis.
   */
  private prepareVariantContext(
    filteredChunks: VectorSearchResult[],
    variant: RewriteResult,
    accountId: number,
    variantIndex: number,
  ): VariantContext {
    // Sort by date, falling back to similarity score when dates are equal or absent
    const uniqueMsgIds = [...new Set(filteredChunks.map(chunk => chunk.xGmMsgId))];
    const dateMap = this.databaseService.getEmailDatesByMsgIds(accountId, uniqueMsgIds);
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

    // Log a preview of the top chunks for debugging
    const chunkPreview = filteredChunks.slice(0, FINAL_CHUNK_LIMIT).map(chunk => {
      const row = this.databaseService.getEmailByXGmMsgId(accountId, chunk.xGmMsgId);
      const subject = (row && (row as Record<string, unknown>).subject != null)
        ? String((row as Record<string, unknown>).subject)
        : '(no subject)';
      const date = dateMap.get(chunk.xGmMsgId) ?? '(no date)';
      return { subject, date, similarity: chunk.similarity };
    });
    log.debug(`[chat] Variant ${variantIndex} filtered chunks (subject, date, similarity):`, chunkPreview);

    const cappedChunks = filteredChunks.slice(0, FINAL_CHUNK_LIMIT);
    const enrichedChunks = this.enrichChunks(cappedChunks, accountId);
    const contextString = this.buildContextString(enrichedChunks);
    return { enrichedChunks, contextString };
  }

  /**
   * Streams the synthesis answer for a single variant.
   * Accumulates tokens locally (forwarding each to callbacks.onToken) and
   * returns a StreamResult describing whether the stream aborted, errored, or
   * completed successfully.
   */
  private async streamVariantAnswer(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    controller: AbortController,
    requestId: string,
    variantIndex: number,
    callbacks: ChatStreamCallbacks,
  ): Promise<StreamResult> {
    let error: string | undefined;
    let accumulatedResponse = '';

    try {
      await this.ollamaService.chatStream(messages, (token: string) => {
        if (!controller.signal.aborted) {
          accumulatedResponse += token;
          callbacks.onToken(token);
        }
      }, { signal: controller.signal });
    } catch (streamErr) {
      if (controller.signal.aborted) {
        log.info('[chat] Stream cancelled by user for requestId:', requestId);
      } else {
        error = streamErr instanceof Error ? streamErr.message : String(streamErr);
        log.error('[chat] Stream error for variant', variantIndex, ':', streamErr);
      }
    }

    return { aborted: controller.signal.aborted, error, accumulatedResponse };
  }

  /**
   * Calls the multi-query rewriter LLM to produce 5 ranked RewriteResult variants
   * for the given question and conversation history.
   *
   * The LLM is instructed to return a JSON array of exactly 5 objects. This method
   * handles robust parsing:
   * - Top-level JSON array → used directly
   * - JSON object with any array-valued property (e.g. `{ queries: [...] }`) → array extracted
   * - Parse failure or fewer than 5 valid items → padded with fallback entries
   *
   * Always returns exactly 5 RewriteResult items. Index 0 is the best-guess variant.
   */
  private async rewriteMultiQuery(
    question: string,
    history: ConversationTurn[],
    signal: AbortSignal,
  ): Promise<RewriteResult[]> {
    const rawPrompt = this.loadPrompt('inbox-chat-rewrite-multi-query.md');

    // Inject today's date into the prompt so the LLM can resolve relative date expressions.
    // Use the local calendar date (not UTC) to match the user's timezone.
    const todayDate = DateTime.now().toLocal().toISODate() ?? '';
    const systemPrompt = rawPrompt.replace(/\{\{TODAY_DATE\}\}/g, todayDate);

    const historyText = history
      .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
      .join('\n');
    const conversationLabel = history.length > 0 ? `Conversation:\n${historyText}\n` : 'Conversation: (empty)\n';
    const userMessage = `${conversationLabel}New question: ${question}`;

    // Request JSON output with a large token budget to accommodate the 5-variant array
    const rawResult = await this.ollamaService.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { temperature: 0.3, numPredict: 1200, format: 'json', signal }
    );

    return this.parseMultiQueryResult(rawResult, question);
  }

  /**
   * Parses the raw LLM output from rewriteMultiQuery() into an array of exactly
   * 5 RewriteResult objects.
   *
   * Parsing strategy:
   * 1. JSON.parse() the trimmed output.
   * 2. If the result is an array, use it directly.
   * 3. If the result is an object, scan its properties for the first array value
   *    (handles wrapped responses like `{ "queries": [...] }` or `{ "results": [...] }`).
   * 4. Validate each array element with isValidRewriteResponse(); salvage all valid items.
   * 5. Pad with fallback entries if fewer than 5 valid items were found.
   */
  private parseMultiQueryResult(rawOutput: string, originalQuestion: string): RewriteResult[] {
    const fallback: RewriteResult = { query: originalQuestion, filters: {}, dateOrder: 'desc' };
    const trimmed = rawOutput.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (parseError) {
      log.warn('[InboxChatService] rewriteMultiQuery JSON parse failed, padding with fallbacks:', {
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
      // LLM wrapped the array in an object — find the first property whose value is an array
      const wrappedArray = Object.values(parsed as Record<string, unknown>).find(
        value => Array.isArray(value)
      );
      if (Array.isArray(wrappedArray)) {
        candidateArray = wrappedArray;
        log.debug('[InboxChatService] rewriteMultiQuery: unwrapped nested array from object response');
      } else {
        log.warn('[InboxChatService] rewriteMultiQuery: parsed object has no array property, padding with fallbacks:', { parsed });
        return Array.from({ length: 5 }, () => ({ ...fallback }));
      }
    } else {
      log.warn('[InboxChatService] rewriteMultiQuery: unexpected parsed type, padding with fallbacks:', {
        type: typeof parsed,
      });
      return Array.from({ length: 5 }, () => ({ ...fallback }));
    }

    // Validate and convert each candidate element; salvage as many as possible
    const validResults: RewriteResult[] = [];
    for (const candidate of candidateArray) {
      if (!this.isValidRewriteResponse(candidate)) {
        log.debug('[InboxChatService] rewriteMultiQuery: skipping invalid array element:', { candidate });
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

      const dateOrder: 'asc' | 'desc' = candidate.dateOrder === 'asc' ? 'asc' : 'desc';

      validResults.push({
        query: candidate.query || originalQuestion,
        filters,
        dateOrder,
      });

      // Stop once we have 5 — extras are discarded
      if (validResults.length === 5) {
        break;
      }
    }

    // Pad up to exactly 5 if the LLM returned fewer valid items
    while (validResults.length < 5) {
      validResults.push({ ...fallback });
    }

    log.info('[InboxChatService] rewriteMultiQuery parsed variants:', {
      validCount: validResults.length,
      candidateCount: candidateArray.length,
      firstQuery: validResults[0].query,
    });

    return validResults;
  }

  /**
   * Type guard that checks the parsed JSON object has the minimum required
   * shape: `query` must be a string; all filter fields, if present, must be
   * strings (not numbers, arrays, etc.).
   */
  private isValidRewriteResponse(value: unknown): value is {
    query: string;
    dateFrom?: string;
    dateTo?: string;
    sender?: string;
    recipient?: string;
    dateOrder?: string;
  } {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as Record<string, unknown>;

    if (typeof candidate['query'] !== 'string') {
      return false;
    }

    const optionalStringFields = ['dateFrom', 'dateTo', 'sender', 'recipient', 'dateOrder'] as const;
    for (const fieldName of optionalStringFields) {
      const fieldValue = candidate[fieldName];
      // Allow null (LLMs commonly emit null for absent optional fields) and undefined.
      // Reject any other non-string type (e.g. number, boolean, array).
      if (fieldValue !== undefined && fieldValue !== null && typeof fieldValue !== 'string') {
        return false;
      }
    }

    return true;
  }

  /**
   * Normalizes local calendar date strings in a SemanticSearchFilters object to
   * UTC ISO timestamp bounds so they can be compared directly against the UTC
   * timestamps stored in the `emails.date` column.
   *
   * - `dateFrom` ("YYYY-MM-DD") → start of that local calendar day in UTC (ISO string)
   * - `dateTo`   ("YYYY-MM-DD") → start of the NEXT local calendar day in UTC (exclusive upper bound)
   *
   * All other filter fields are passed through unchanged.
   */
  private normalizeFilterDates(filters: SemanticSearchFilters): SemanticSearchFilters {
    const normalized: SemanticSearchFilters = { ...filters };

    if (filters.dateFrom !== undefined) {
      const utcFrom = this.localCalendarDateToUtcIso(filters.dateFrom, false);
      if (utcFrom !== null) {
        normalized.dateFrom = utcFrom;
      } else {
        // Invalid date string — drop the filter to avoid incorrect results
        delete normalized.dateFrom;
        log.warn('[InboxChatService] normalizeFilterDates: invalid dateFrom string, filter dropped:', filters.dateFrom);
      }
    }

    if (filters.dateTo !== undefined) {
      // dateTo is converted to the start of the NEXT local day (exclusive upper bound)
      const utcTo = this.localCalendarDateToUtcIso(filters.dateTo, true);
      if (utcTo !== null) {
        normalized.dateTo = utcTo;
      } else {
        delete normalized.dateTo;
        log.warn('[InboxChatService] normalizeFilterDates: invalid dateTo string, filter dropped:', filters.dateTo);
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
    // fromFormat is strict: only accepts exactly "yyyy-MM-dd" (no datetimes, week dates, etc.)
    // zone: 'local' ensures midnight is local calendar midnight, not UTC midnight
    const localDate = DateTime.fromFormat(dateString, 'yyyy-MM-dd', { zone: 'local' });

    if (!localDate.isValid) {
      return null;
    }

    const targetDate = nextDay ? localDate.plus({ days: 1 }) : localDate;
    return targetDate.toUTC().toISO() ?? null;
  }

  private enrichChunks(
    chunks: Array<{ xGmMsgId: string; chunkText: string; similarity: number }>,
    accountId: number
  ): EnrichedChunk[] {
    // Batch-load email metadata for all unique message IDs
    const uniqueMsgIds = [...new Set(chunks.map(chunk => chunk.xGmMsgId))];
    const emailMetadata = new Map<string, {
      fromName: string;
      fromAddress: string;
      toAddresses: string;
      subject: string;
      date: string;
    }>();

    for (const xGmMsgId of uniqueMsgIds) {
      const row = this.databaseService.getEmailByXGmMsgId(accountId, xGmMsgId);
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

    // Prepend email header to the first chunk from each email so the LLM has context
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

      // Format the date as human-readable for the LLM header (e.g. "March 6, 2024 at 10:30 AM").
      // The raw ISO date string is preserved in the EnrichedChunk.date field for the renderer.
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
   * Parses citation markers from the LLM's completed response text and returns
   * a deduplicated list of `SourceEmail` objects — one per unique email — in
   * the order they were first cited.
   *
   * Supported formats:
   * - `[N]`
   * - `[N,M]`
   * - `[N, M, P]`
   *
   * Algorithm:
   * 1. Extract every bracketed numeric citation group from the response.
   * 2. Split each group on commas and parse each citation number in order.
   * 3. Bounds-check each citation against enrichedChunks.
   * 4. Deduplicate: keep only the first citation encountered for each unique
   *    `xGmMsgId` (multiple chunks can come from the same email).
   * 5. Build `SourceEmail` objects in citation order with `citationIndex` set
   *    to the citation number that first referenced that email.
   * 6. If no valid citations are found, return an empty array.
   */
  private parseCitedSources(responseText: string, enrichedChunks: EnrichedChunk[]): SourceEmail[] {
    const citationPattern = /\[([\d\s,]+)\]/g;
    const seenMsgIds = new Set<string>();
    const citedSources: SourceEmail[] = [];

    let match: RegExpExecArray | null;
    while ((match = citationPattern.exec(responseText)) !== null) {
      const citationNumbers = match[1]
        .split(',')
        .map((rawCitation) => rawCitation.trim())
        .filter((rawCitation) => rawCitation.length > 0)
        .map((rawCitation) => parseInt(rawCitation, 10))
        .filter((citationNumber) => Number.isInteger(citationNumber));

      for (const citationNumber of citationNumbers) {
        // Bounds-check: [N] must map to a real chunk (1-based index)
        if (citationNumber < 1 || citationNumber > enrichedChunks.length) {
          continue;
        }

        const chunk = enrichedChunks[citationNumber - 1];

        // Deduplicate by email: only the first citation of each email is kept
        if (seenMsgIds.has(chunk.xGmMsgId)) {
          continue;
        }

        seenMsgIds.add(chunk.xGmMsgId);
        citedSources.push({
          xGmMsgId: chunk.xGmMsgId,
          fromName: chunk.fromName,
          fromAddress: chunk.fromAddress,
          subject: chunk.subject,
          date: chunk.date,
          citationIndex: citationNumber,
        });
      }
    }

    log.info('[InboxChatService] Citation parsing complete:', {
      totalChunks: enrichedChunks.length,
      citedSourceCount: citedSources.length,
    });

    return citedSources;
  }

  private buildContextString(enrichedChunks: EnrichedChunk[]): string {
    return enrichedChunks
      .map((chunk, index) => `[${index + 1}] ${chunk.chunkText}`)
      .join('\n\n---\n\n');
  }

  private buildMessages(
    systemPrompt: string,
    contextString: string,
    history: ConversationTurn[],
    question: string,
  ): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    const contextualSystem = `${systemPrompt}\n\n## Email Context\n\n${contextString}`;
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
      { role: 'system', content: contextualSystem },
    ];

    for (const turn of history) {
      messages.push({ role: turn.role, content: turn.content });
    }

    messages.push({ role: 'user', content: question });
    return messages;
  }

  /**
   * Assesses whether the retrieved email chunks are relevant to the user's question.
   *
   * Calls the relevance-check LLM with a lightweight JSON prompt. The LLM receives:
   * - System message: the relevance-check assessor prompt (do NOT answer, only judge)
   * - Middle messages: conversation history turns for follow-up context
   * - Final user message: the full enriched context string + the question
   *
   * The LLM returns `{"relevant": true}` or `{"relevant": false}`.
   *
   * Fallback: if parsing fails or the `relevant` field is absent/non-boolean,
   * returns `true` (conservative — proceed to synthesis rather than skipping).
   */
  private async checkRelevance(
    question: string,
    conversationHistory: ConversationTurn[],
    contextString: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const systemPrompt = this.loadPrompt('inbox-chat-relevance-check.md');

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
      rawResult = await this.ollamaService.chat(messages, {
        temperature: 0.3,
        numPredict: 50,
        format: 'json',
        signal,
      });
    } catch (callError) {
      // If the user aborted, rethrow so the calling loop's catch block handles
      // cancellation correctly. We must NOT fall through to synthesis after an abort.
      if (signal.aborted) {
        throw callError;
      }
      // For all other failures (network, model, timeout, etc.) conservatively
      // treat the context as relevant so synthesis still proceeds.
      log.warn('[InboxChatService] checkRelevance: LLM call failed, defaulting to relevant=true:', callError);
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

      log.warn('[InboxChatService] checkRelevance: missing or non-boolean "relevant" field, defaulting to true:', {
        rawResult: rawResult.slice(0, 200),
      });
      return true;
    } catch (parseError) {
      log.warn('[InboxChatService] checkRelevance: JSON parse failed, defaulting to relevant=true:', {
        rawResult: rawResult.slice(0, 200),
        parseError,
      });
      return true;
    }
  }

  private loadPrompt(filename: string): string {
    // Dev path: relative to this compiled file (dist-electron/services/ → electron/prompts/)
    const devPath = path.join(__dirname, '..', 'prompts', filename);

    if (fs.existsSync(devPath)) {
      return fs.readFileSync(devPath, 'utf-8');
    }

    // Production path: inside the asar archive (resolved via resourcesPath)
    const prodPath = path.join(
      process.resourcesPath || '',
      'app.asar',
      'electron',
      'prompts',
      filename
    );

    if (fs.existsSync(prodPath)) {
      return fs.readFileSync(prodPath, 'utf-8');
    }

    log.warn(`[InboxChatService] Prompt file not found: ${filename}`);
    return '';
  }
}
