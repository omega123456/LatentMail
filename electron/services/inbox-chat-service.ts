import * as path from 'path';
import * as fs from 'fs';
import { LoggerService } from './logger-service';
import { DatabaseService } from './database-service';
import { OllamaService } from './ollama-service';
import { VectorDbService } from './vector-db-service';

const log = LoggerService.getInstance();

interface EnrichedChunk {
  xGmMsgId: string;
  fromName: string;
  fromAddress: string;
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
}

export interface ChatStreamCallbacks {
  onToken: (token: string) => void;
  onSources: (sources: SourceEmail[]) => void;
  onDone: (cancelled: boolean, error?: string) => void;
}

/** Maximum number of vector search result chunks to retrieve per query. */
const TOP_CHUNKS = 15;

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
    callbacks: ChatStreamCallbacks,
  ): Promise<void> {
    const controller = new AbortController();
    this.activeControllers.set(requestId, controller);

    try {
      // Step 1: Query rewriting (only when conversation history exists)
      let embeddingQuery = question;
      if (conversationHistory.length > 0) {
        try {
          embeddingQuery = await this.rewriteQuery(question, conversationHistory);
          log.info('[InboxChatService] Rewrote query:', { original: question, rewritten: embeddingQuery });
        } catch (rewriteError) {
          log.warn('[InboxChatService] Query rewriting failed, using raw question:', rewriteError);
          embeddingQuery = question;
        }
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

      // Step 3: Vector search (synchronous — returns VectorSearchResult[])
      const chunks = this.vectorDbService.search(embedding, accountId, TOP_CHUNKS);
      if (!chunks || chunks.length === 0) {
        // No relevant results — send a friendly fallback message
        callbacks.onToken(
          "I don't see any emails in your index that are relevant to that question. " +
          'Try asking about something else, or make sure your email index is up to date.'
        );
        callbacks.onSources([]);
        callbacks.onDone(false);
        return;
      }

      // Check cancellation after vector search — before the LLM streaming call.
      if (controller.signal.aborted) {
        callbacks.onDone(true);
        return;
      }

      // Step 4: Enrich chunks with email metadata from the local database
      const enrichedChunks = this.enrichChunks(chunks, accountId);

      // Step 5: Extract unique source emails for citation display
      const sources = this.extractSources(enrichedChunks);

      // Step 6: Build a formatted context string for the LLM
      const contextString = this.buildContextString(enrichedChunks);

      // Step 7: Load the system prompt from the prompts directory
      const systemPrompt = this.loadPrompt('inbox-chat-system.md');

      // Step 8: Assemble the full message list for the LLM
      const messages = this.buildMessages(systemPrompt, contextString, conversationHistory, question);

      // Step 9: Stream LLM response, forwarding tokens to the caller
      let streamError: string | undefined;
      try {
        await this.ollamaService.chatStream(messages, (token: string) => {
          if (!controller.signal.aborted) {
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

      // Step 10: Emit sources and completion signal
      callbacks.onSources(sources);
      callbacks.onDone(controller.signal.aborted, streamError);
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

  private async rewriteQuery(question: string, history: ConversationTurn[]): Promise<string> {
    const systemPrompt = this.loadPrompt('inbox-chat-rewrite-query.md');
    const historyText = history
      .map(turn => `${turn.role === 'user' ? 'User' : 'Assistant'}: ${turn.content}`)
      .join('\n');
    const userMessage = `Conversation:\n${historyText}\nNew question: ${question}`;

    // Pass the system prompt as a system-role message (OllamaChatMessage format)
    const result = await this.ollamaService.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      { numPredict: 50 }
    );

    return result.trim() || question;
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
      subject: string;
      date: string;
    }>();

    for (const xGmMsgId of uniqueMsgIds) {
      const row = this.databaseService.getEmailByXGmMsgId(accountId, xGmMsgId);
      if (row) {
        emailMetadata.set(xGmMsgId, {
          fromName: String(row['fromName'] ?? row['fromAddress'] ?? 'Unknown'),
          fromAddress: String(row['fromAddress'] ?? ''),
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
      const subject = meta?.subject ?? '(No subject)';
      const date = meta?.date ?? '';

      return {
        xGmMsgId: chunk.xGmMsgId,
        fromName,
        fromAddress,
        subject,
        date,
        chunkText: isFirstChunk
          ? `From: ${fromName} <${fromAddress}> | Subject: ${subject} | Date: ${date}\n${chunk.chunkText}`
          : chunk.chunkText,
      };
    });
  }

  private extractSources(enrichedChunks: EnrichedChunk[]): SourceEmail[] {
    const seen = new Set<string>();
    const sources: SourceEmail[] = [];
    for (const chunk of enrichedChunks) {
      if (!seen.has(chunk.xGmMsgId)) {
        seen.add(chunk.xGmMsgId);
        sources.push({
          xGmMsgId: chunk.xGmMsgId,
          fromName: chunk.fromName,
          fromAddress: chunk.fromAddress,
          subject: chunk.subject,
          date: chunk.date,
        });
      }
    }
    return sources;
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
