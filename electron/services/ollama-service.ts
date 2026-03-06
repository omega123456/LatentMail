import { LoggerService } from './logger-service';
import { BrowserWindow } from 'electron';

const log = LoggerService.getInstance();
import { DatabaseService } from './database-service';
import * as crypto from 'crypto';
import { SearchIntent } from '../utils/search-query-generator';
import { loadPrompt } from '../utils/prompt-loader';
import { SemanticSearchIntent, SemanticSearchFilters } from '../utils/search-filter-translator';

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
  private currentEmbeddingModel: string = '';
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
      const embeddingModel = db.getSetting('ollamaEmbeddingModel');
      if (embeddingModel) {
        this.currentEmbeddingModel = embeddingModel;
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
  getStatus(): { connected: boolean; url: string; currentModel: string; embeddingModel: string } {
    return {
      connected: this.connected,
      url: this.baseUrl,
      currentModel: this.currentModel,
      embeddingModel: this.currentEmbeddingModel,
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

  /** Get the currently selected embedding model, or empty string if none */
  getEmbeddingModel(): string {
    return this.currentEmbeddingModel;
  }

  /** Update selected embedding model (persists to DB) */
  setEmbeddingModel(model: string): void {
    this.currentEmbeddingModel = model;
    try {
      const db = DatabaseService.getInstance();
      db.setSetting('ollamaEmbeddingModel', model);
    } catch (err) {
      log.warn('Failed to save Ollama embedding model to DB:', err);
    }
  }

  /**
   * Call Ollama's /api/embed endpoint with an array of text inputs.
   * Returns a 2D array of float vectors (one vector per input string).
   *
   * @param texts - Array of strings to embed
   * @param model - Embedding model name (defaults to currentEmbeddingModel)
   * @param timeoutMs - Request timeout in milliseconds (default 60s)
   */
  async embed(texts: string[], model?: string, timeoutMs: number = 60_000): Promise<number[][]> {
    const embeddingModel = model || this.currentEmbeddingModel;
    if (!embeddingModel) {
      throw new Error('No embedding model selected. Please select an embedding model in Settings > AI.');
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel, input: texts }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Ollama embed failed (${response.status}): ${text}`);
      }

      const data = await response.json() as { embeddings: number[][] };
      if (!Array.isArray(data.embeddings)) {
        throw new Error('Ollama embed response missing embeddings array');
      }
      return data.embeddings;
    } catch (err) {
      clearTimeout(timeout);
      throw err;
    }
  }

  /**
   * Validate that a model supports the /api/embed endpoint by performing a test embed.
   * Returns the vector dimension on success, throws on failure.
   *
   * @param model - Model name to validate
   * @returns Vector dimension (e.g. 768 for nomic-embed-text)
   */
  async validateEmbeddingModel(model: string): Promise<number> {
    const embeddings = await this.embed(['test'], model, 10_000);
    if (!embeddings[0] || embeddings[0].length === 0) {
      throw new Error('Embedding model returned empty vector');
    }
    return embeddings[0].length;
  }

  /** Get the base URL for Ollama (used by worker threads that call Ollama directly) */
  getBaseUrl(): string {
    return this.baseUrl;
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
      log.info('[Ollama] chat response', { model, contentLen: content.length, content });
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
   *
   * If `options.signal` is provided, aborting it will abort the HTTP connection.
   */
  async chatStream(
    messages: OllamaChatMessage[],
    onToken: (token: string) => void,
    options?: {
      model?: string;
      temperature?: number;
      format?: 'json' | string;
      numPredict?: number;
      signal?: AbortSignal;
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
    // Wire up external cancellation signal if provided
    if (options?.signal) {
      if (options.signal.aborted) {
        controller.abort();
      } else {
        options.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }
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

      log.info('[Ollama] chatStream complete', { model, fullTextLen: fullText.length, content: fullText });
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
        content: loadPrompt('summarize-thread'),
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
        content: loadPrompt('reply-suggestions'),
      },
      {
        role: 'user',
        content: threadContent,
      },
    ];

    const result = await this.chat(messages, { format: 'json', temperature: 0.8 });

    log.info('[Ollama] reply-suggestions raw response', { contentLen: result.length, content: result });

    let stringResults: string[] = [];
    try {
      const parsed = JSON.parse(result);
      if (Array.isArray(parsed?.suggestions)) {
        stringResults = parsed.suggestions.slice(0, 3).map((s: unknown) => String(s));
      } else {
        log.error('[Ollama] reply-suggestions unexpected format', { parsed });
      }
    } catch (parseErr) {
      log.error('[Ollama] reply-suggestions JSON parse failed', { error: parseErr, raw: result });
    }

    if (stringResults.length > 0) {
      this.setCachedResult('reply-suggestions', cacheKey, JSON.stringify(stringResults));
    }
    return stringResults;
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
        content: loadPrompt('compose-email', {
          contextInstruction: context ? 'Use the provided context/thread for reference.\n\n' : '',
        }),
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
    const transformFile =
      ['improve', 'shorten', 'formalize', 'casualize'].includes(transformation)
        ? `transform-${transformation}`
        : 'transform-default';
    const systemPrompt = loadPrompt(
      transformFile,
      transformFile === 'transform-default' ? { transformation } : undefined
    );

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

  /**
   * Extract structured search intent from natural language.
   */
  async extractSearchIntent(
    query: string,
    userEmail: string,
    todayDate: string,
    folders: string[]
  ): Promise<SearchIntent> {
    const normalizedFolders = Array.from(
      new Set(
        folders
          .map((folder) => folder.trim())
          .filter((folder) => folder.length > 0)
      )
    ).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    const cacheInput = `${query}|${userEmail}|${todayDate}|${normalizedFolders.join(',')}`;
    const cacheKey = this.getCacheKey('search-intent', cacheInput);
    const cached = this.getCachedResult('search-intent', cacheKey);
    if (cached) {
      try {
        const parsedCached = JSON.parse(cached) as unknown;
        if (this.isSearchIntent(parsedCached)) {
          log.debug('[Ollama] extractSearchIntent: returning cached result', { query, cacheKey });
          return this.normalizeSearchIntent(parsedCached);
        }
        log.warn('[Ollama] extractSearchIntent: cached value failed validation, regenerating');
      } catch {
        log.warn('[Ollama] extractSearchIntent: failed to parse cached value, regenerating');
      }
    }

    const folderList = normalizedFolders.length > 0
      ? normalizedFolders.map((folder) => `- ${folder}`).join('\n')
      : '- (none provided)';

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: loadPrompt('extract-search-intent', {
          userEmail: userEmail || '(unknown)',
          todayDate,
          folderList,
        }),
      },
      {
        role: 'user',
        content: query,
      },
    ];

    const raw = await this.chat(messages, { format: 'json', temperature: 0.2 });
    log.info('[Ollama] extractSearchIntent: raw response', { query, raw });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      const objectMatch = raw.match(/\{[\s\S]*\}/);
      if (!objectMatch) {
        throw new Error('AI returned non-JSON search intent');
      }
      parsed = JSON.parse(objectMatch[0]) as unknown;
    }

    parsed = this.backfillSearchIntent(parsed);

    if (!this.isSearchIntent(parsed)) {
      log.warn('[Ollama] extractSearchIntent: invalid structure after backfill', { raw, parsed });
      throw new Error('AI returned invalid SearchIntent structure');
    }

    const normalizedIntent = this.normalizeSearchIntent(parsed);
    if (!this.hasMeaningfulConstraints(normalizedIntent)) {
      throw new Error('AI returned SearchIntent without any search constraints');
    }

    this.setCachedResult('search-intent', cacheKey, JSON.stringify(normalizedIntent));
    return normalizedIntent;
  }

  private isSearchIntent(value: unknown): value is SearchIntent {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    if (!this.isStringArray(candidate['keywords'])) {
      return false;
    }
    if (!this.isStringArray(candidate['synonyms'])) {
      return false;
    }
    if (candidate['direction'] !== 'sent' && candidate['direction'] !== 'received' && candidate['direction'] !== 'any') {
      return false;
    }
    if (candidate['folder'] !== null && typeof candidate['folder'] !== 'string') {
      return false;
    }
    if (candidate['sender'] !== null && typeof candidate['sender'] !== 'string') {
      return false;
    }
    if (candidate['recipient'] !== null && typeof candidate['recipient'] !== 'string') {
      return false;
    }
    if (!this.isValidDateRange(candidate['dateRange'])) {
      return false;
    }
    if (!this.isValidFlags(candidate['flags'])) {
      return false;
    }
    if (!this.isStringArray(candidate['exactPhrases'])) {
      return false;
    }
    if (!this.isStringArray(candidate['negations'])) {
      return false;
    }
    return true;
  }

  private hasMeaningfulConstraints(intent: SearchIntent): boolean {
    if (intent.keywords.length > 0 || intent.exactPhrases.length > 0) {
      return true;
    }
    const flags = intent.flags;
    if (flags.unread === true || flags.starred === true || flags.important === true || flags.hasAttachment === true) {
      return true;
    }
    if (intent.folder != null || intent.sender != null || intent.recipient != null || intent.dateRange != null) {
      return true;
    }
    return false;
  }

  private isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
  }

  private isValidDateRange(value: unknown): boolean {
    if (value == null) {
      return true;
    }
    if (typeof value !== 'object') {
      return false;
    }
    const dateRange = value as Record<string, unknown>;
    if (dateRange['after'] != null && typeof dateRange['after'] !== 'string') {
      return false;
    }
    if (dateRange['before'] != null && typeof dateRange['before'] !== 'string') {
      return false;
    }
    if (dateRange['relative'] != null && typeof dateRange['relative'] !== 'string') {
      return false;
    }
    return true;
  }

  private isValidFlags(value: unknown): boolean {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const flags = value as Record<string, unknown>;
    if (flags['unread'] != null && typeof flags['unread'] !== 'boolean') {
      return false;
    }
    if (flags['starred'] != null && typeof flags['starred'] !== 'boolean') {
      return false;
    }
    if (flags['important'] != null && typeof flags['important'] !== 'boolean') {
      return false;
    }
    if (flags['hasAttachment'] != null && typeof flags['hasAttachment'] !== 'boolean') {
      return false;
    }
    return true;
  }

  private backfillSearchIntent(value: unknown): unknown {
    if (!value || typeof value !== 'object') {
      return value;
    }
    const obj = value as Record<string, unknown>;
    const patched: Record<string, unknown> = { ...obj };
    const patchedFields: string[] = [];

    if (!Array.isArray(patched['keywords'])) {
      patched['keywords'] = [];
      patchedFields.push('keywords');
    }
    if (!Array.isArray(patched['synonyms'])) {
      patched['synonyms'] = [];
      patchedFields.push('synonyms');
    }
    if (patched['direction'] !== 'sent' && patched['direction'] !== 'received' && patched['direction'] !== 'any') {
      patchedFields.push(`direction(${String(patched['direction'])} -> "any")`);
      patched['direction'] = 'any';
    }
    if (!('folder' in patched) || (typeof patched['folder'] !== 'string' && patched['folder'] !== null)) {
      patched['folder'] = null;
      patchedFields.push('folder');
    }
    if (!('sender' in patched) || (typeof patched['sender'] !== 'string' && patched['sender'] !== null)) {
      patched['sender'] = null;
      patchedFields.push('sender');
    }
    if (!('recipient' in patched) || (typeof patched['recipient'] !== 'string' && patched['recipient'] !== null)) {
      patched['recipient'] = null;
      patchedFields.push('recipient');
    }
    if (!('dateRange' in patched) || (patched['dateRange'] !== null && typeof patched['dateRange'] !== 'object')) {
      patched['dateRange'] = null;
      patchedFields.push('dateRange');
    }
    if (!patched['flags'] || typeof patched['flags'] !== 'object') {
      patched['flags'] = {};
      patchedFields.push('flags');
    } else {
      const flags = patched['flags'] as Record<string, unknown>;
      const cleanedFlags: Record<string, boolean> = {};
      for (const key of ['unread', 'starred', 'important', 'hasAttachment']) {
        if (typeof flags[key] === 'boolean') {
          cleanedFlags[key] = flags[key];
        } else if (flags[key] !== undefined) {
          patchedFields.push(`flags.${key}(dropped non-boolean: ${String(flags[key])})`);
        }
      }
      patched['flags'] = cleanedFlags;
    }
    if (!Array.isArray(patched['exactPhrases'])) {
      patched['exactPhrases'] = [];
      patchedFields.push('exactPhrases');
    }
    if (!Array.isArray(patched['negations'])) {
      patched['negations'] = [];
      patchedFields.push('negations');
    }

    if (patchedFields.length > 0) {
      log.debug('[Ollama] backfillSearchIntent: patched fields', { patchedFields });
    }

    return patched;
  }

  private normalizeSearchIntent(intent: SearchIntent): SearchIntent {
    const keywords = Array.from(
      new Set(
        intent.keywords
          .map((keyword) => keyword.trim())
          .filter((keyword) => keyword.length > 0)
      )
    );
    const synonyms = Array.from(
      new Set(
        intent.synonyms
          .map((synonym) => synonym.trim())
          .filter((synonym) => synonym.length > 0)
      )
    );
    const exactPhrases = Array.from(
      new Set(
        intent.exactPhrases
          .map((phrase) => phrase.trim())
          .filter((phrase) => phrase.length > 0)
      )
    );
    const negations = Array.from(
      new Set(
        intent.negations
          .map((negation) => negation.trim())
          .filter((negation) => negation.length > 0)
      )
    );

    const folder = intent.folder && intent.folder.trim().length > 0 ? intent.folder.trim() : null;
    const sender = intent.sender && intent.sender.trim().length > 0 ? intent.sender.trim() : null;
    const recipient = intent.recipient && intent.recipient.trim().length > 0 ? intent.recipient.trim() : null;

    let dateRange: SearchIntent['dateRange'] = null;
    if (intent.dateRange) {
      const after = intent.dateRange.after?.trim();
      const before = intent.dateRange.before?.trim();
      const relative = intent.dateRange.relative?.trim();
      if (after || before || relative) {
        dateRange = {
          ...(after ? { after } : {}),
          ...(before ? { before } : {}),
          ...(relative ? { relative } : {}),
        };
      }
    }

    return {
      keywords,
      synonyms,
      direction: intent.direction,
      folder,
      sender,
      recipient,
      dateRange,
      flags: {
        ...(intent.flags.unread !== undefined ? { unread: intent.flags.unread } : {}),
        ...(intent.flags.starred !== undefined ? { starred: intent.flags.starred } : {}),
        ...(intent.flags.important !== undefined ? { important: intent.flags.important } : {}),
        ...(intent.flags.hasAttachment !== undefined ? { hasAttachment: intent.flags.hasAttachment } : {}),
      },
      exactPhrases,
      negations,
    };
  }

  /**
   * Extract structured semantic intent from natural language using the
   * extract-semantic-intent prompt. Returns a `SemanticSearchIntent` containing
   * a topic-only `semanticQuery` string (suitable for embedding search) and a
   * `filters` object with all structured constraints.
   */
  async extractSemanticIntent(
    query: string,
    userEmail: string,
    todayDate: string,
    folders: string[]
  ): Promise<SemanticSearchIntent> {
    const normalizedFolders = Array.from(
      new Set(
        folders
          .map((folder) => folder.trim())
          .filter((folder) => folder.length > 0)
      )
    ).sort((folderA, folderB) => folderA.localeCompare(folderB, undefined, { sensitivity: 'base' }));

    const cacheInput = `${query}|${userEmail}|${todayDate}|${normalizedFolders.join(',')}`;
    const cacheKey = this.getCacheKey('semantic-intent', cacheInput);
    const cached = this.getCachedResult('semantic-intent', cacheKey);
    if (cached) {
      try {
        const parsedCached = JSON.parse(cached) as unknown;
        if (this.isSemanticSearchIntent(parsedCached)) {
          log.debug('[Ollama] extractSemanticIntent: returning cached result', { query, cacheKey });
          return parsedCached;
        }
        log.warn('[Ollama] extractSemanticIntent: cached value failed validation, regenerating');
      } catch {
        log.warn('[Ollama] extractSemanticIntent: failed to parse cached value, regenerating');
      }
    }

    const messages: OllamaChatMessage[] = [
      {
        role: 'system',
        content: loadPrompt('extract-semantic-intent', {
          userEmail: userEmail || '(unknown)',
          todayDate,
          folderList: normalizedFolders.length > 0 ? normalizedFolders.join(', ') : '(none provided)',
        }),
      },
      {
        role: 'user',
        content: query,
      },
    ];

    const raw = await this.chat(messages, { format: 'json', temperature: 0.2 });
    log.info('[Ollama] extractSemanticIntent: raw response', { query, raw });

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      const objectMatch = raw.match(/\{[\s\S]*\}/);
      if (!objectMatch) {
        throw new Error('AI returned non-JSON semantic intent');
      }
      parsed = JSON.parse(objectMatch[0]) as unknown;
    }

    const validated = this.validateSemanticIntentResponse(parsed, query);

    this.setCachedResult('semantic-intent', cacheKey, JSON.stringify(validated));
    return validated;
  }

  /**
   * Validates and backfills a raw parsed JSON value into a well-formed
   * `SemanticSearchIntent`. Fields with wrong types are removed; date strings
   * not matching YYYY-MM-DD are removed. If `semanticQuery` is missing or not
   * a string, falls back to the original `query` parameter.
   */
  private validateSemanticIntentResponse(parsed: unknown, originalQuery: string): SemanticSearchIntent {
    const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

    let semanticQuery: string;
    let filtersRaw: Record<string, unknown> = {};

    if (parsed !== null && typeof parsed === 'object') {
      const parsedRecord = parsed as Record<string, unknown>;

      if (typeof parsedRecord['semanticQuery'] === 'string') {
        semanticQuery = parsedRecord['semanticQuery'];
      } else {
        log.debug('[Ollama] validateSemanticIntentResponse: semanticQuery missing or wrong type, falling back to original query');
        semanticQuery = originalQuery;
      }

      if (parsedRecord['filters'] !== null && typeof parsedRecord['filters'] === 'object' && !Array.isArray(parsedRecord['filters'])) {
        filtersRaw = parsedRecord['filters'] as Record<string, unknown>;
      } else {
        log.debug('[Ollama] validateSemanticIntentResponse: filters missing or wrong type, using {}');
      }
    } else {
      log.debug('[Ollama] validateSemanticIntentResponse: parsed value is not an object, falling back to original query');
      semanticQuery = originalQuery;
    }

    const filters: SemanticSearchFilters = {};

    if (typeof filtersRaw['dateFrom'] === 'string') {
      if (ISO_DATE_PATTERN.test(filtersRaw['dateFrom'])) {
        filters.dateFrom = filtersRaw['dateFrom'];
      } else {
        log.debug('[Ollama] validateSemanticIntentResponse: dateFrom failed format check, dropping', { value: filtersRaw['dateFrom'] });
      }
    } else if (filtersRaw['dateFrom'] !== undefined) {
      log.debug('[Ollama] validateSemanticIntentResponse: dateFrom has wrong type, dropping', { type: typeof filtersRaw['dateFrom'] });
    }

    if (typeof filtersRaw['dateTo'] === 'string') {
      if (ISO_DATE_PATTERN.test(filtersRaw['dateTo'])) {
        filters.dateTo = filtersRaw['dateTo'];
      } else {
        log.debug('[Ollama] validateSemanticIntentResponse: dateTo failed format check, dropping', { value: filtersRaw['dateTo'] });
      }
    } else if (filtersRaw['dateTo'] !== undefined) {
      log.debug('[Ollama] validateSemanticIntentResponse: dateTo has wrong type, dropping', { type: typeof filtersRaw['dateTo'] });
    }

    if (typeof filtersRaw['folder'] === 'string') {
      filters.folder = filtersRaw['folder'];
    } else if (filtersRaw['folder'] !== undefined) {
      log.debug('[Ollama] validateSemanticIntentResponse: folder has wrong type, dropping', { type: typeof filtersRaw['folder'] });
    }

    if (typeof filtersRaw['sender'] === 'string') {
      filters.sender = filtersRaw['sender'];
    } else if (filtersRaw['sender'] !== undefined) {
      log.debug('[Ollama] validateSemanticIntentResponse: sender has wrong type, dropping', { type: typeof filtersRaw['sender'] });
    }

    if (typeof filtersRaw['recipient'] === 'string') {
      filters.recipient = filtersRaw['recipient'];
    } else if (filtersRaw['recipient'] !== undefined) {
      log.debug('[Ollama] validateSemanticIntentResponse: recipient has wrong type, dropping', { type: typeof filtersRaw['recipient'] });
    }

    if (typeof filtersRaw['hasAttachment'] === 'boolean') {
      filters.hasAttachment = filtersRaw['hasAttachment'];
    } else if (filtersRaw['hasAttachment'] !== undefined) {
      log.debug('[Ollama] validateSemanticIntentResponse: hasAttachment has wrong type, dropping', { type: typeof filtersRaw['hasAttachment'] });
    }

    if (typeof filtersRaw['isRead'] === 'boolean') {
      filters.isRead = filtersRaw['isRead'];
    } else if (filtersRaw['isRead'] !== undefined) {
      log.debug('[Ollama] validateSemanticIntentResponse: isRead has wrong type, dropping', { type: typeof filtersRaw['isRead'] });
    }

    if (typeof filtersRaw['isStarred'] === 'boolean') {
      filters.isStarred = filtersRaw['isStarred'];
    } else if (filtersRaw['isStarred'] !== undefined) {
      log.debug('[Ollama] validateSemanticIntentResponse: isStarred has wrong type, dropping', { type: typeof filtersRaw['isStarred'] });
    }

    return { semanticQuery, filters };
  }

  /**
   * Type guard for `SemanticSearchIntent`. Checks that the value has the
   * required shape: an object with a string `semanticQuery` and an object
   * `filters`. Does not deeply validate filter field types.
   */
  private isSemanticSearchIntent(value: unknown): value is SemanticSearchIntent {
    if (value === null || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    if (typeof candidate['semanticQuery'] !== 'string') {
      return false;
    }
    if (candidate['filters'] === null || typeof candidate['filters'] !== 'object' || Array.isArray(candidate['filters'])) {
      return false;
    }
    return true;
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
        content: loadPrompt('generate-filter'),
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
        content: loadPrompt('detect-follow-up'),
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
      // Default expiry: 7 days
      const expiresInDays = 7;
      db.setAiCacheResult(operation, inputHash, this.currentModel, result, expiresInDays);
    } catch (err) {
      log.warn('Failed to cache AI result:', err);
    }
  }
}
