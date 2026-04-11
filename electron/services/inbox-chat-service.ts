import { DateTime } from 'luxon';
import { LoggerService } from './logger-service';
import { OllamaService } from './ollama-service';
import { VariantSearchService, EnrichedChunk, ConversationTurn } from './variant-search-service';
import { loadPrompt } from '../utils/prompt-loader';

const log = LoggerService.getInstance();

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

/** Result returned by streamVariantAnswer(). */
interface StreamResult {
  aborted: boolean;
  error: string | undefined;
  accumulatedResponse: string;
}

export class InboxChatService {
  private activeControllers = new Map<string, AbortController>();

  constructor(
    private readonly ollamaService: OllamaService,
    private readonly variantSearch: VariantSearchService,
  ) {}

  async chat(
    requestId: string,
    question: string,
    conversationHistory: ConversationTurn[],
    accountId: number,
    accountEmail: string,
    folders: string[],
    callbacks: ChatStreamCallbacks,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(requestId, controller);

    try {
      // ── Phase 1: Delegate retrieval to VariantSearchService ──────────────────
      const todayDate = DateTime.now().toLocal().toISODate() ?? '';

      const result = await this.variantSearch.search(
        question,
        conversationHistory,
        accountId,
        controller.signal,
        todayDate,
        accountEmail,
        folders,
        undefined,  // excludedFolders: chat pipeline doesn't need folder exclusion
      );

      if (this.handleAbort(controller.signal, callbacks)) {
        return;
      }

      // ── Phase 2: Handle no-results case ──────────────────────────────────────
      if (result === null) {
        log.info('[chat] All variants exhausted, no relevant emails found');
        callbacks.onToken(
          "I couldn't find any emails that match what you're looking for. " +
          'Try rephrasing your question, or ask about a different topic. If you just added mail, give sync a moment to finish.'
        );
        callbacks.onSources([]);
        callbacks.onDone(false);
        return;
      }

      // ── Phase 3: Build system prompt and synthesize answer ───────────────────
      const systemPrompt = this.buildSystemPrompt(accountEmail);

      const streamCompleted = await this.streamVariantSynthesis(
        result.enrichedChunks,
        result.contextString,
        systemPrompt,
        conversationHistory,
        question,
        controller,
        requestId,
        callbacks,
      );

      if (!streamCompleted) {
        // streamVariantSynthesis returns false only if it did not call callbacks.onDone
        // (which should not happen in practice, but guard defensively)
        callbacks.onDone(false);
      }
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

  private async streamVariantSynthesis(
    enrichedChunks: EnrichedChunk[],
    contextString: string,
    systemPrompt: string,
    conversationHistory: ConversationTurn[],
    question: string,
    controller: AbortController,
    requestId: string,
    callbacks: ChatStreamCallbacks,
  ): Promise<boolean> {
    log.debug('[chat] Beginning synthesis');
    const messages = this.buildMessages(systemPrompt, contextString, conversationHistory, question);
    const streamResult = await this.streamVariantAnswer(messages, controller, requestId, callbacks);

    if (streamResult.aborted || streamResult.error !== undefined) {
      callbacks.onSources([]);
      callbacks.onDone(streamResult.aborted, streamResult.error);
      return true;
    }

    const citedSources = this.parseCitedSources(streamResult.accumulatedResponse, enrichedChunks);
    callbacks.onSources(citedSources);
    callbacks.onDone(false);
    log.debug('[chat] Answer streamed successfully');
    return true;
  }

  /**
   * Streams the synthesis answer.
   * Accumulates tokens locally (forwarding each to callbacks.onToken) and
   * returns a StreamResult describing whether the stream aborted, errored, or
   * completed successfully.
   */
  private async streamVariantAnswer(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    controller: AbortController,
    requestId: string,
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
        log.error('[chat] Stream error:', streamErr);
      }
    }

    return { aborted: controller.signal.aborted, error, accumulatedResponse };
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
    const rawSystemPrompt = loadPrompt('inbox-chat-system', {
      'CURRENT_DATETIME': currentDateTimeFormatted,
      'USER_EMAIL': accountEmail,
    });
    return rawSystemPrompt;
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
}
