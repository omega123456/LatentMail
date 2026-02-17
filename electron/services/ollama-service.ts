import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import { DatabaseService } from './database-service';
import * as crypto from 'crypto';

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  digest: string;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    num_predict?: number;
  };
  format?: 'json' | string;
}

export interface OllamaChatResponse {
  model: string;
  message: OllamaChatMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export class OllamaService {
  private static instance: OllamaService;
  private baseUrl: string = 'http://localhost:11434';
  private connected: boolean = false;
  private currentModel: string = '';
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private readonly HEALTH_CHECK_INTERVAL = 30_000; // 30 seconds

  private constructor() {
    this.loadSettings();
  }

  static getInstance(): OllamaService {
    if (!OllamaService.instance) {
      OllamaService.instance = new OllamaService();
    }
    return OllamaService.instance;
  }

  /** Load Ollama settings from database */
  private loadSettings(): void {
    try {
      const db = DatabaseService.getInstance();
      const url = db.getSetting('ollamaUrl');
      if (url) {
        this.baseUrl = url;
      }
      const model = db.getSetting('ollamaModel');
      if (model) {
        this.currentModel = model;
      }
    } catch (err) {
      log.warn('Failed to load Ollama settings from DB:', err);
    }
  }

  /** Start periodic health checks */
  startHealthChecks(): void {
    this.stopHealthChecks();
    // Immediate check
    this.checkHealth().catch(() => {});
    this.healthCheckTimer = setInterval(() => {
      this.checkHealth().catch(() => {});
    }, this.HEALTH_CHECK_INTERVAL);
  }

  /** Stop periodic health checks */
  stopHealthChecks(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  /** Check if Ollama is reachable */
  async checkHealth(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      const response = await fetch(this.baseUrl, { signal: controller.signal });
      clearTimeout(timeout);
      const wasConnected = this.connected;
      this.connected = response.ok;
      if (this.connected !== wasConnected) {
        log.info(`Ollama connection status changed: ${this.connected ? 'connected' : 'disconnected'}`);
        this.broadcastStatus();
      }
      return this.connected;
    } catch {
      if (this.connected) {
        log.info('Ollama disconnected');
        this.connected = false;
        this.broadcastStatus();
      }
      return false;
    }
  }

  /** Broadcast AI status to all renderer windows */
  private broadcastStatus(): void {
    const status = this.getStatus();
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('ai:status', status);
      }
    }
  }

  /** Get current connection status */
  getStatus(): { connected: boolean; url: string; currentModel: string } {
    return {
      connected: this.connected,
      url: this.baseUrl,
      currentModel: this.currentModel,
    };
  }

  /** Update Ollama base URL */
  async setUrl(url: string): Promise<void> {
    this.baseUrl = url;
    try {
      const db = DatabaseService.getInstance();
      db.setSetting('ollamaUrl', url);
    } catch (err) {
      log.warn('Failed to save Ollama URL to DB:', err);
    }
    await this.checkHealth();
  }

  /** Update selected model */
  setModel(model: string): void {
    this.currentModel = model;
    try {
      const db = DatabaseService.getInstance();
      db.setSetting('ollamaModel', model);
    } catch (err) {
      log.warn('Failed to save Ollama model to DB:', err);
    }
  }

  /** Get the currently selected model, or empty string if none */
  getModel(): string {
    return this.currentModel;
  }

  /** List available models from Ollama */
  async listModels(): Promise<OllamaModel[]> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        throw new Error(`Ollama returned status ${response.status}`);
      }

      const data = await response.json() as { models: OllamaModel[] };
      return data.models || [];
    } catch (err) {
      log.error('Failed to list Ollama models:', err);
      throw err;
    }
  }

  /** Send a chat completion request (non-streaming) */
  async chat(messages: OllamaChatMessage[], options?: {
    model?: string;
    temperature?: number;
    format?: 'json' | string;
    numPredict?: number;
  }): Promise<string> {
    const model = options?.model || this.currentModel;
    if (!model) {
      log.warn('[Ollama] chat called with no model selected');
      throw new Error('No AI model selected. Please select a model in Settings > AI.');
    }

    log.info('[Ollama] chat request', { model, stream: false, messageCount: messages.length });
    const body: OllamaChatRequest = {
      model,
      messages,
      stream: false,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.numPredict,
      },
    };
    if (options?.format) {
      body.format = options.format;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120_000); // 2 min timeout
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log.error('[Ollama] chat HTTP error', { status: response.status, body: text.slice(0, 200) });
        throw new Error(`Ollama chat failed (${response.status}): ${text}`);
      }

      const data = await response.json() as OllamaChatResponse;
      const content = data.message?.content || '';
      log.info('[Ollama] chat response', { model, contentLen: content.length });
      return content;
    } catch (err) {
      clearTimeout(timeout);
      log.error('[Ollama] chat failed', err);
      throw err;
    }
  }

  /**
   * Send a streaming chat completion request.
   * Calls `onToken` for each token as it arrives, and `onDone` when finished.
   * Returns the full accumulated response text.
   */
  async chatStream(
    messages: OllamaChatMessage[],
    onToken: (token: string) => void,
    options?: {
      model?: string;
      temperature?: number;
      format?: 'json' | string;
      numPredict?: number;
    }
  ): Promise<string> {
    const model = options?.model || this.currentModel;
    if (!model) {
      log.warn('[Ollama] chatStream called with no model selected');
      throw new Error('No AI model selected. Please select a model in Settings > AI.');
    }

    log.info('[Ollama] chatStream request', { model, stream: true, messageCount: messages.length });
    const body: OllamaChatRequest = {
      model,
      messages,
      stream: true,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: options?.numPredict,
      },
    };
    if (options?.format) {
      body.format = options.format;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 300_000); // 5 min for streaming
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        log.error('[Ollama] chatStream HTTP error', { status: response.status, body: text.slice(0, 200) });
        throw new Error(`Ollama stream failed (${response.status}): ${text}`);
      }

      if (!response.body) {
        log.error('[Ollama] chatStream: response has no body');
        throw new Error('Ollama response has no body');
      }

      let fullText = '';
      let lineBuffer = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        const chunk = decoder.decode(value, { stream: true });
        // Ollama streams NDJSON; keep a carry-over buffer for partial lines.
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) {
            continue;
          }
          try {
            const parsed = JSON.parse(trimmed) as OllamaChatResponse;
            if (parsed.message?.content) {
              fullText += parsed.message.content;
              onToken(parsed.message.content);
            }
          } catch {
            // Skip malformed lines
          }
        }
      }

      const trailing = lineBuffer.trim();
      if (trailing) {
        try {
          const parsed = JSON.parse(trailing) as OllamaChatResponse;
          if (parsed.message?.content) {
            fullText += parsed.message.content;
            onToken(parsed.message.content);
          }
        } catch {
          // Ignore malformed trailing data
        }
      }

      log.info('[Ollama] chatStream complete', { model, fullTextLen: fullText.length });
      return fullText;
    } catch (err) {
      clearTimeout(timeout);
      log.error('[Ollama] chatStream failed', err);
      throw err;
    }
  }

  // ============================
  // High-level AI Operations
  // ============================

  /** Summarize an email thread */
  async summarizeThread(
    threadContent: string,
    streamToWindow?: BrowserWindow,
    requestId?: string
  ): Promise<string> {
    const cacheKey = this.getCacheKey('summarize', threadContent);
    const cached = this.getCachedResult('summarize', cacheKey);
    if (cached) {
      return cached;
    }

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are an email assistant. Summarize the following email thread concisely.
Provide:
1. A brief 1-2 sentence summary
2. Key points as bullet points
3. Any action items

Keep it concise and factual. Do not add information not present in the emails.`,
      },
      {
        role: 'user',
        content: threadContent,
      },
    ];

    let result: string;
    if (streamToWindow && !streamToWindow.isDestroyed()) {
      result = await this.chatStream(messages, (token) => {
        if (!streamToWindow.isDestroyed()) {
          streamToWindow.webContents.send('ai:stream', {
            type: 'summarize',
            token,
            done: false,
            requestId,
          });
        }
      });
      if (!streamToWindow.isDestroyed()) {
        streamToWindow.webContents.send('ai:stream', {
          type: 'summarize',
          token: '',
          done: true,
          requestId,
        });
      }
    } else {
      result = await this.chat(messages);
    }

    this.setCachedResult('summarize', cacheKey, result);
    return result;
  }

  /** Generate smart reply suggestions */
  async generateReplySuggestions(threadContent: string): Promise<string[]> {
    const cacheKey = this.getCacheKey('reply-suggestions', threadContent);
    const cached = this.getCachedResult('reply-suggestions', cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as string[];
      } catch {
        // Cache was invalid, regenerate
      }
    }

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are an email assistant. Based on the email thread below, generate exactly 3 short reply suggestions.
Each suggestion should be a complete, ready-to-send reply (1-2 sentences).
Use different tones: one professional, one casual, one grateful/appreciative.

Return a JSON array of exactly 3 strings. Example:
["Thanks for the update! I'll review this by end of day.", "Got it, looks good to me.", "I really appreciate you sharing this — I'll take a look right away."]

Return ONLY the JSON array, no other text.`,
      },
      {
        role: 'user',
        content: threadContent,
      },
    ];

    const result = await this.chat(messages, { format: 'json', temperature: 0.8 });

    try {
      const parsed = JSON.parse(result);
      const suggestions = Array.isArray(parsed) ? parsed : (parsed.suggestions || parsed.replies || []);
      const stringResults = suggestions.slice(0, 3).map((s: unknown) => String(s));
      this.setCachedResult('reply-suggestions', cacheKey, JSON.stringify(stringResults));
      return stringResults;
    } catch {
      // If JSON parsing fails, try to extract suggestions from the text
      const lines = result.split('\n').filter(l => l.trim().length > 10);
      const fallback = lines.slice(0, 3);
      return fallback.length > 0 ? fallback : [result.trim()];
    }
  }

  /** AI compose: generate an email draft from a prompt */
  async composeEmail(
    prompt: string,
    context?: string,
    streamToWindow?: BrowserWindow,
    requestId?: string
  ): Promise<string> {
    const streaming = !!(streamToWindow && !streamToWindow.isDestroyed());
    log.info('[Ollama] composeEmail', { requestId, promptLen: prompt.length, hasContext: !!context, streaming });

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are an email writing assistant. Write an email based on the user's instructions.
${context ? 'Use the provided context/thread for reference.' : ''}
Write naturally and professionally. Include a greeting and sign-off unless the user specifies otherwise.
Return ONLY the email body text (no subject line, no metadata).`,
      },
    ];

    if (context) {
      messages.push({
        role: 'user',
        content: `Context/Previous thread:\n${context}\n\nInstructions: ${prompt}`,
      });
    } else {
      messages.push({
        role: 'user',
        content: prompt,
      });
    }

    if (streamToWindow && !streamToWindow.isDestroyed()) {
      const result = await this.chatStream(messages, (token) => {
        if (!streamToWindow.isDestroyed()) {
          streamToWindow.webContents.send('ai:stream', {
            type: 'compose',
            token,
            done: false,
            requestId,
          });
        }
      });
      if (!streamToWindow.isDestroyed()) {
        streamToWindow.webContents.send('ai:stream', {
          type: 'compose',
          token: '',
          done: true,
          requestId,
        });
      }
      log.info('[Ollama] composeEmail done (streamed)', { requestId, resultLen: result.length });
      return result;
    }

    const result = await this.chat(messages);
    log.info('[Ollama] composeEmail done (non-stream)', { requestId, resultLen: result.length });
    return result;
  }

  /** Transform text (improve, shorten, formalize, casualize) */
  async transformText(
    text: string,
    transformation: string,
    streamToWindow?: BrowserWindow,
    requestId?: string
  ): Promise<string> {
    const transformPrompts: Record<string, string> = {
      improve: 'Improve the writing quality of the following text. Fix grammar, improve clarity, and enhance readability. Keep the same meaning and tone.',
      shorten: 'Make the following text shorter and more concise while keeping the key message intact. Remove unnecessary words and filler.',
      formalize: 'Rewrite the following text in a more formal, professional tone. Keep the same meaning.',
      casualize: 'Rewrite the following text in a more casual, friendly tone. Keep the same meaning.',
    };

    const systemPrompt = transformPrompts[transformation]
      || `Transform the following text: ${transformation}`;

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `${systemPrompt}\n\nReturn ONLY the transformed text, nothing else.`,
      },
      {
        role: 'user',
        content: text,
      },
    ];

    if (streamToWindow && !streamToWindow.isDestroyed()) {
      const result = await this.chatStream(messages, (token) => {
        if (!streamToWindow.isDestroyed()) {
          streamToWindow.webContents.send('ai:stream', {
            type: 'transform',
            token,
            done: false,
            requestId,
          });
        }
      }, { temperature: 0.5 });
      if (!streamToWindow.isDestroyed()) {
        streamToWindow.webContents.send('ai:stream', {
          type: 'transform',
          token: '',
          done: true,
          requestId,
        });
      }
      return result;
    }

    return this.chat(messages, { temperature: 0.5 });
  }

  /** Categorize an email into categories */
  async categorizeEmail(emailContent: string): Promise<string> {
    const cacheKey = this.getCacheKey('categorize', emailContent);
    const cached = this.getCachedResult('categorize', cacheKey);
    if (cached) {
      return cached;
    }

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are an email categorization assistant. Classify the following email into exactly ONE of these categories:
- Primary (personal or important messages that need attention)
- Updates (notifications, confirmations, receipts)
- Promotions (marketing, deals, newsletters from companies)
- Social (social network notifications, community updates)
- Newsletters (subscribed content, digests, editorial newsletters)

Return ONLY the category name as a JSON object: {"category": "Primary"}`,
      },
      {
        role: 'user',
        content: emailContent,
      },
    ];

    const result = await this.chat(messages, { format: 'json', temperature: 0.3 });
    try {
      const parsed = JSON.parse(result) as { category: string };
      const category = parsed.category || 'Primary';
      this.setCachedResult('categorize', cacheKey, category);
      return category;
    } catch {
      return 'Primary';
    }
  }

  /**
   * Natural language search: convert a natural language query into a Gmail search string.
   *
   * @param query - The user's natural language query
   * @param userEmail - The user's email address (for self-reference: "emails I sent")
   * @param todayDate - Today's date in YYYY-MM-DD format (for relative date computation)
   * @returns An object with a single `query` field containing the Gmail search string
   */
  async naturalLanguageSearch(
    query: string,
    userEmail: string,
    todayDate: string
  ): Promise<{ query: string }> {
    const cacheKey = this.getCacheKey('search', `${query}|${userEmail}|${todayDate}`);
    const cached = this.getCachedResult('search', cacheKey);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { query: string };
        if (parsed.query && typeof parsed.query === 'string') {
          return parsed;
        }
      } catch {
        // Cache was invalid, regenerate
      }
    }

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are a Gmail search query translator. Convert the user's natural language into a single Gmail search query string.

## Your task
Take the user's natural language description and produce a Gmail search query using the operators below. Return ONLY a JSON object with one field: "query".

## Context
- The user's email address is: ${userEmail}
- Today's date is: ${todayDate}

## Gmail search operators you can use (ONLY these — do not use any others)
| Operator | Meaning | Example |
|----------|---------|---------|
| from: | Sender name or partial address | from:james |
| to: | Recipient | to:sarah |
| subject: | Subject keywords | subject:meeting |
| has:attachment | Has attachments | has:attachment |
| is:unread | Unread messages | is:unread |
| is:read | Read messages | is:read |
| is:starred | Starred messages | is:starred |
| is:important | Important messages | is:important |
| after: | After date (YYYY/MM/DD) | after:2025/02/01 |
| before: | Before date (YYYY/MM/DD) | before:2025/02/15 |
| newer_than: | Relative recency | newer_than:7d |
| older_than: | Relative age | older_than:3d |
| "" | Exact phrase | "project deadline" |
| - | Negation | -from:noreply |

**Do NOT use** these operators: cc:, bcc:, filename:, larger:, smaller:, label:, in:, OR, parentheses (). They are not supported by this search system.

## Critical rules
1. **Never invent email addresses.** If the user says "from james", produce \`from:james\`, NOT \`from:james@example.com\`. Never append @example.com or any domain.
2. **Simple name queries**: "james" → \`james\` (matches across all fields). Do NOT add operators unless the user's intent is specific.
3. **Sender queries**: "from james" → \`from:james\`. "emails james sent me" → \`from:james\`.
4. **Self-reference**: "emails I sent" or "my sent emails" → \`from:${userEmail}\`. "emails to me" → \`to:${userEmail}\`.
5. **Date handling**:
   - "last week" → \`newer_than:7d\`
   - "yesterday" → \`newer_than:1d\`
   - "this month" → compute \`after:YYYY/MM/01\` from today's date
   - "in January" or "in January 2025" → \`after:2025/01/01 before:2025/02/01\`
   - "last month" → compute the prior month's date range
6. **Compound queries**: "unread emails from james about the project with attachments" → \`is:unread from:james subject:project has:attachment\`
7. **Passthrough**: If the query already contains Gmail operators (from:, is:, etc.), pass it through with minimal cleanup.
8. **Minimal transformation**: Don't over-engineer. If the user types a simple keyword, just return that keyword. Gmail will match it across all fields.

## Output format
Return ONLY a JSON object: {"query": "your gmail search string"}
Do not include any explanation, markdown, or text outside the JSON.`,
      },
      {
        role: 'user',
        content: query,
      },
    ];

    const result = await this.chat(messages, { format: 'json', temperature: 0.3 });

    // Validate and parse AI output
    let parsedQuery: string;
    try {
      const parsed = JSON.parse(result) as { query?: string };
      if (parsed.query && typeof parsed.query === 'string' && parsed.query.trim().length > 0) {
        parsedQuery = parsed.query.trim();
      } else {
        log.warn('[Ollama] naturalLanguageSearch: AI returned empty or invalid query field, falling back to raw input');
        parsedQuery = query;
      }
    } catch {
      // Try regex extraction as fallback
      const match = result.match(/"query"\s*:\s*"([^"]+)"/);
      if (match && match[1]) {
        parsedQuery = match[1].trim();
        log.warn('[Ollama] naturalLanguageSearch: JSON parse failed but extracted query via regex');
      } else {
        log.warn('[Ollama] naturalLanguageSearch: All parsing failed, falling back to raw input');
        parsedQuery = query;
      }
    }

    // Validate length
    if (parsedQuery.length > 2048) {
      log.warn('[Ollama] naturalLanguageSearch: Query exceeds 2048 chars, truncating');
      parsedQuery = parsedQuery.substring(0, 2048);
    }

    const output = { query: parsedQuery };
    this.setCachedResult('search', cacheKey, JSON.stringify(output));
    return output;
  }

  /** AI-assisted filter creation: generate filter rules from natural language description */
  async generateFilter(description: string, accountId: number): Promise<{
    name: string;
    conditions: Array<{ field: string; operator: string; value: string }>;
    actions: Array<{ type: string; value?: string }>;
  }> {
    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are an email filter assistant. Generate an email filter rule based on the user's natural language description.

Return a JSON object with the following structure:
{
  "name": "Filter name",
  "conditions": [
    {"field": "from|to|subject|body|has-attachment", "operator": "contains|equals|starts-with|ends-with|matches", "value": "some value"}
  ],
  "actions": [
    {"type": "label|archive|delete|star|mark-read|move", "value": "optional label name or folder"}
  ]
}

Field options: from, to, subject, body, has-attachment
Operator options: contains, equals, starts-with, ends-with, matches
Action type options: label, archive, delete, star, mark-read, move

You may specify multiple conditions and multiple actions.
Return ONLY the JSON object, no other text.`,
      },
      {
        role: 'user',
        content: description,
      },
    ];

    const result = await this.chat(messages, { format: 'json', temperature: 0.3 });
    try {
      const parsed = JSON.parse(result) as {
        name: string;
        conditions: Array<{ field: string; operator: string; value: string }>;
        actions: Array<{ type: string; value?: string }>;
      };
      return {
        name: parsed.name || 'AI-generated filter',
        conditions: Array.isArray(parsed.conditions) ? parsed.conditions : [],
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
      };
    } catch {
      log.warn('[Ollama] Failed to parse filter generation result:', result);
      throw new Error('AI returned invalid filter format');
    }
  }

  /** Detect if a sent email likely expects a follow-up reply */
  async detectFollowUp(emailContent: string): Promise<{
    needsFollowUp: boolean;
    reason: string;
    suggestedDate?: string;
  }> {
    const cacheKey = this.getCacheKey('followup', emailContent);
    const cached = this.getCachedResult('followup', cacheKey);
    if (cached) {
      try {
        return JSON.parse(cached) as { needsFollowUp: boolean; reason: string; suggestedDate?: string };
      } catch {
        // Cache was invalid, regenerate
      }
    }

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: `You are an email follow-up assistant. Analyze the email below and determine if it likely expects a reply or follow-up from the recipient(s).

Consider:
- Does the email ask a question?
- Does it request action or feedback?
- Is it a proposal or request awaiting approval?
- Does it end with language suggesting a reply is expected?

Return a JSON object:
{
  "needsFollowUp": true/false,
  "reason": "Brief explanation of why follow-up is or isn't needed",
  "suggestedDate": "YYYY-MM-DD suggested follow-up date (3-7 days from now, only if needsFollowUp is true)"
}

Return ONLY the JSON, no other text.`,
      },
      {
        role: 'user',
        content: emailContent,
      },
    ];

    const result = await this.chat(messages, { format: 'json', temperature: 0.3 });
    try {
      const parsed = JSON.parse(result) as { needsFollowUp: boolean; reason: string; suggestedDate?: string };
      const output = {
        needsFollowUp: !!parsed.needsFollowUp,
        reason: parsed.reason || '',
        suggestedDate: parsed.suggestedDate,
      };
      this.setCachedResult('followup', cacheKey, JSON.stringify(output));
      return output;
    } catch {
      return { needsFollowUp: false, reason: 'Could not determine follow-up status' };
    }
  }

  // ============================
  // AI Cache helpers
  // ============================

  private getCacheKey(operation: string, input: string): string {
    return crypto.createHash('sha256').update(input).digest('hex');
  }

  private getCachedResult(operation: string, inputHash: string): string | null {
    try {
      const db = DatabaseService.getInstance();
      return db.getAiCacheResult(operation, inputHash, this.currentModel);
    } catch {
      return null;
    }
  }

  private setCachedResult(operation: string, inputHash: string, result: string): void {
    try {
      const db = DatabaseService.getInstance();
      // Default expiry: 7 days for summaries, indefinite for categorization
      const expiresInDays = operation === 'categorize' ? null : 7;
      db.setAiCacheResult(operation, inputHash, this.currentModel, result, expiresInDays);
    } catch (err) {
      log.warn('Failed to cache AI result:', err);
    }
  }
}
