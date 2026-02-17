import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import { DatabaseService } from './database-service';
import * as crypto from 'crypto';
import { SearchIntent } from '../utils/search-query-generator';
import { loadPrompt } from '../utils/prompt-loader';

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
        content: loadPrompt('categorize-email'),
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
    if (normalizedIntent.keywords.length === 0) {
      throw new Error('AI returned SearchIntent without keywords');
    }

    this.setCachedResult('search-intent', cacheKey, JSON.stringify(normalizedIntent));
    return normalizedIntent;
  }

  private isSearchIntent(value: unknown): value is SearchIntent {
    if (!value || typeof value !== 'object') {
      return false;
    }
    const candidate = value as Record<string, unknown>;
    if (!this.isStringArray(candidate['keywords']) || candidate['keywords'].length === 0) {
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
      // Default expiry: 7 days for summaries, indefinite for categorization
      const expiresInDays = operation === 'categorize' ? null : 7;
      db.setAiCacheResult(operation, inputHash, this.currentModel, result, expiresInDays);
    } catch (err) {
      log.warn('Failed to cache AI result:', err);
    }
  }
}
