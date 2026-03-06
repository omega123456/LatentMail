import * as path from 'path';
import * as fs from 'fs';
import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { OllamaService } from './ollama-service';
import { VectorDbService } from './vector-db-service';
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
const VECTOR_CANDIDATE_BUDGET = 200;

/**
 * Maximum number of vector search candidate chunks when structured filters
 * (date/sender/recipient) are present. A larger budget ensures broad filter
 * queries (e.g., "all emails from Alice") can find enough DB-matched candidates
 * even when the semantic query is generic.
 */
const VECTOR_CANDIDATE_BUDGET_FILTERED = 1360;

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
      // Step 1: Query rewriting (always runs — extracts semantic query + structured filters)
      let embeddingQuery = question;
      let extractedFilters: SemanticSearchFilters = {};
      let sortDirection: 'asc' | 'desc' = 'desc';
      try {
        const rewriteResult = await this.rewriteQuery(question, conversationHistory);
        embeddingQuery = rewriteResult.query;
        extractedFilters = rewriteResult.filters;
        sortDirection = rewriteResult.dateOrder;
        log.info('[InboxChatService] Rewrote query:', {
          original: question,
          rewritten: embeddingQuery,
          filters: extractedFilters,
          dateOrder: sortDirection,
        });
      } catch (rewriteError) {
        log.warn('[InboxChatService] Query rewriting failed, using raw question:', rewriteError);
        embeddingQuery = question;
        extractedFilters = {};
      }

      // Check cancellation after query rewriting — the rewrite is the first async
      // LLM call and may take a noticeable amount of time; bail out early if the
      // user already cancelled before we proceed to embedding and vector search.
      if (controller.signal.aborted) {
        callbacks.onDone(true);
        return;
      }

      // Step 2: Embed the query (embed() takes a string array, returns number[][])
      const embeddings = await this.ollamaService.embed([embeddingQuery]);
      const embedding = embeddings[0];
      if (!embedding || embedding.length === 0) {
        throw new Error('Failed to generate embedding for query');
      }

      // Check cancellation after embedding — allows fast bail-out before the
      // more expensive vector search + LLM steps.
      if (controller.signal.aborted) {
        callbacks.onDone(true);
        return;
      }

      // Determine whether structured filters were extracted — used to choose the
      // vector search budget and filtering strategy below.
      const hasExtractedFilters =
        extractedFilters.dateFrom !== undefined ||
        extractedFilters.dateTo !== undefined ||
        extractedFilters.sender !== undefined ||
        extractedFilters.recipient !== undefined;

      // Step 3: Vector search — retrieve candidates before filtering.
      // Use a larger budget when structured filters are present so that broad
      // filter queries (e.g., "all emails from Alice") don't miss matches that
      // rank lower semantically but perfectly match the filter criteria.
      const vectorBudget = hasExtractedFilters ? VECTOR_CANDIDATE_BUDGET_FILTERED : VECTOR_CANDIDATE_BUDGET;
      const candidateChunks = this.vectorDbService.search(embedding, accountId, vectorBudget);

      // Step 3a: Apply structured DB filters (date/sender/recipient) if any were extracted,
      // then (filtered branch only) apply similarity threshold. When no filters: apply
      // similarity threshold only.
      let filteredChunks: typeof candidateChunks;

      if (hasExtractedFilters) {
        // Normalize local date strings to UTC ISO timestamp bounds for accurate filtering.
        // The LLM emits local calendar dates (YYYY-MM-DD); emails are stored as UTC timestamps.
        // dateFrom → start of that local calendar day in UTC
        // dateTo   → start of the NEXT local calendar day in UTC (exclusive upper bound)
        const normalizedFilters = this.normalizeFilterDates(extractedFilters);

        // Filters-first: pass all candidates through DB filtering, then filter by similarity.
        const uniqueMsgIds = [...new Set(candidateChunks.map(chunk => chunk.xGmMsgId))];
        const matchingMsgIdSet = this.databaseService.filterEmailsByMsgIds(
          accountId,
          uniqueMsgIds,
          normalizedFilters,
        );
        filteredChunks = candidateChunks
          .filter(chunk => matchingMsgIdSet.has(chunk.xGmMsgId))
          .filter(chunk => chunk.similarity >= SIMILARITY_THRESHOLD);

        log.info('[InboxChatService] DB filter + similarity applied:', {
          candidateCount: candidateChunks.length,
          afterFilter: filteredChunks.length,
          filters: normalizedFilters,
        });
      } else {
        // Semantic-only: apply similarity threshold to discard irrelevant noise
        filteredChunks = candidateChunks.filter(
          chunk => chunk.similarity >= SIMILARITY_THRESHOLD
        );
      }

      if (filteredChunks.length === 0) {
        // No chunks survived filtering — send a friendly fallback message
        callbacks.onToken(
          "I don't see any emails in your index that are relevant to that question. " +
          'Try asking about something else, or make sure your email index is up to date.'
        );
        callbacks.onSources([]);
        callbacks.onDone(false);
        return;
      }

      // Step 3b: Sort by date (direction determined by the query rewrite LLM, default desc),
      // then by similarity descending within the same date. Chunks without a date go to the end.
      const uniqueMsgIdsForSort = [...new Set(filteredChunks.map(chunk => chunk.xGmMsgId))];
      const dateMap = this.databaseService.getEmailDatesByMsgIds(accountId, uniqueMsgIdsForSort);
      filteredChunks.sort((chunkA, chunkB) => {
        const dateA = dateMap.get(chunkA.xGmMsgId);
        const dateB = dateMap.get(chunkB.xGmMsgId);
        if (!dateA && !dateB) {
          return chunkB.similarity - chunkA.similarity;
        }
        if (!dateA) {
          return 1;
        }
        if (!dateB) {
          return -1;
        }
        const dateCmp = sortDirection === 'asc'
          ? dateA.localeCompare(dateB)
          : dateB.localeCompare(dateA);
        if (dateCmp !== 0) {
          return dateCmp;
        }
        return chunkB.similarity - chunkA.similarity;
      });

      // Step 3c: Cap the final chunk list before passing to the LLM
      const chunks = filteredChunks.slice(0, FINAL_CHUNK_LIMIT);

      // Check cancellation after vector search — before the LLM streaming call.
      if (controller.signal.aborted) {
        callbacks.onDone(true);
        return;
      }

      // Step 4: Enrich chunks with email metadata from the local database
      const enrichedChunks = this.enrichChunks(chunks, accountId);

      // Step 5: Build a formatted context string for the LLM.
      // Chunks are numbered [1], [2], … [N] in the context; the LLM is
      // instructed to cite those numbers inline so we can map them back to
      // source emails after streaming completes.
      const contextString = this.buildContextString(enrichedChunks);

      // Step 6: Load the system prompt from the prompts directory and inject
      // the current date/time and the user's email address so the LLM has
      // temporal awareness and directional reasoning (sent vs. received).
      const currentDateTimeFormatted = new Intl.DateTimeFormat(undefined, {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date());

      const rawSystemPrompt = this.loadPrompt('inbox-chat-system.md');
      const systemPrompt = rawSystemPrompt
        .replaceAll('{{CURRENT_DATETIME}}', currentDateTimeFormatted)
        .replaceAll('{{USER_EMAIL}}', accountEmail);

      // Step 7: Assemble the full message list for the LLM
      const messages = this.buildMessages(systemPrompt, contextString, conversationHistory, question);

      // Step 8: Stream LLM response, forwarding tokens to the caller and
      // accumulating the full response text for post-stream citation parsing.
      let streamError: string | undefined;
      let accumulatedResponse: string = '';
      try {
        await this.ollamaService.chatStream(messages, (token: string) => {
          if (!controller.signal.aborted) {
            accumulatedResponse += token;
            callbacks.onToken(token);
          }
        }, { signal: controller.signal });
      } catch (streamErr) {
        // Distinguish between cancellation and genuine errors
        if (controller.signal.aborted) {
          // Aborted — not a real error, just user cancellation
          log.info('[InboxChatService] Stream cancelled by user for requestId:', requestId);
        } else {
          streamError = streamErr instanceof Error ? streamErr.message : String(streamErr);
          log.error('[InboxChatService] Stream error:', streamErr);
        }
      }

      // Step 9: Emit sources and completion signal.
      // On cancellation or error, partial citations are unreliable — emit no
      // sources so the UI shows nothing rather than misleading partial results.
      if (controller.signal.aborted || streamError !== undefined) {
        callbacks.onSources([]);
        callbacks.onDone(controller.signal.aborted, streamError);
        return;
      }

      // Parse [N] citation markers from the completed response and build the
      // source list containing only the emails the LLM actually referenced.
      const citedSources = this.parseCitedSources(accumulatedResponse, enrichedChunks);
      callbacks.onSources(citedSources);
      callbacks.onDone(false);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error('[InboxChatService] Chat pipeline error:', error);
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

  private async rewriteQuery(question: string, history: ConversationTurn[]): Promise<RewriteResult> {
    const rawPrompt = this.loadPrompt('inbox-chat-rewrite-query.md');

    // Inject today's date into the prompt so the LLM can resolve relative date expressions.
    // Use the local calendar date (not UTC) to match the user's timezone.
    const now = new Date();
    const todayDate = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    ].join('-');
    const systemPrompt = rawPrompt.replace(/\{\{TODAY_DATE\}\}/g, todayDate);

    const historyText = history
      .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
      .join('\n');
    const conversationLabel = history.length > 0 ? `Conversation:\n${historyText}\n` : 'Conversation: (empty)\n';
    const userMessage = `${conversationLabel}New question: ${question}`;

    // Request JSON output with sufficient token budget for the response object
    const rawResult = await this.ollamaService.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { numPredict: 200, format: 'json' }
    );

    return this.parseRewriteResult(rawResult, question);
  }

  /**
   * Parses the raw LLM output from rewriteQuery() into a RewriteResult.
   *
   * If the output is valid JSON with the expected shape, returns the parsed
   * result. If parsing fails or the `query` field is missing or not a string,
   * falls back to treating the raw output as the plain query with no filters.
   */
  private parseRewriteResult(rawOutput: string, originalQuestion: string): RewriteResult {
    const trimmed = rawOutput.trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (parseError) {
      log.warn('[InboxChatService] rewriteQuery JSON parse failed, using raw output as query:', {
        rawOutput: trimmed,
        parseError,
      });
      return { query: trimmed || originalQuestion, filters: {}, dateOrder: 'desc' };
    }

    // Type guard: validate the parsed object has the expected shape
    if (!this.isValidRewriteResponse(parsed)) {
      log.warn('[InboxChatService] rewriteQuery JSON shape invalid, using original question:', {
        parsed,
      });
      return { query: originalQuestion, filters: {}, dateOrder: 'desc' };
    }

    const filters: SemanticSearchFilters = {};

    if (typeof parsed.dateFrom === 'string' && parsed.dateFrom.length > 0) {
      filters.dateFrom = parsed.dateFrom;
    }

    if (typeof parsed.dateTo === 'string' && parsed.dateTo.length > 0) {
      filters.dateTo = parsed.dateTo;
    }

    if (typeof parsed.sender === 'string' && parsed.sender.length > 0) {
      filters.sender = parsed.sender;
    }

    if (typeof parsed.recipient === 'string' && parsed.recipient.length > 0) {
      filters.recipient = parsed.recipient;
    }

    const dateOrder: 'asc' | 'desc' = parsed.dateOrder === 'asc' ? 'asc' : 'desc';

    return {
      query: parsed.query || originalQuestion,
      filters,
      dateOrder,
    };
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

    // Formatter for human-readable dates in chunk headers (LLM context only)
    const chunkDateFormatter = new Intl.DateTimeFormat(undefined, {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

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
        const parsedDate = new Date(date);
        formattedDate = isNaN(parsedDate.getTime()) ? date : chunkDateFormatter.format(parsedDate);
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
   * Parses `[N]` citation markers from the LLM's completed response text and
   * returns a deduplicated list of `SourceEmail` objects — one per unique email
   * — in the order they were first cited.
   *
   * Algorithm:
   * 1. Extract every `[N]` match from the response (global regex).
   * 2. Parse each N as an integer and bounds-check against enrichedChunks.
   * 3. Deduplicate: keep only the first citation number encountered for each
   *    unique `xGmMsgId` (multiple chunks can come from the same email).
   * 4. Build `SourceEmail` objects in citation order with `citationIndex` set
   *    to the `[N]` number.
   * 5. If no valid citations are found, return an empty array.
   */
  private parseCitedSources(responseText: string, enrichedChunks: EnrichedChunk[]): SourceEmail[] {
    const citationPattern = /\[(\d+)\]/g;
    const seenMsgIds = new Set<string>();
    const citedSources: SourceEmail[] = [];

    let match: RegExpExecArray | null;
    while ((match = citationPattern.exec(responseText)) !== null) {
      const citationNumber = parseInt(match[1], 10);

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
