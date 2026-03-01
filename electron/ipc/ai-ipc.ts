import { ipcMain, BrowserWindow } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { OllamaService } from '../services/ollama-service';
import { DatabaseService } from '../services/database-service';
import { VectorDbService } from '../services/vector-db-service';
import { EmbeddingService } from '../services/embedding-service';
import { SearchIntent, SearchQueryGenerator } from '../utils/search-query-generator';

function isAllowedOllamaUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.toLowerCase();
    const isLocalHost = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
    const hasCredentials = parsed.username.length > 0 || parsed.password.length > 0;
    return isLocalHost && isHttp && !hasCredentials;
  } catch {
    return false;
  }
}

/** Fallback system folders used when DB labels are not available. */
const FALLBACK_SYSTEM_FOLDERS = [
  'INBOX',
  '[Gmail]/Sent Mail',
  '[Gmail]/Drafts',
  '[Gmail]/Trash',
  '[Gmail]/Spam',
  '[Gmail]/Starred',
  '[Gmail]/Important',
];

/**
 * Build the system folder list dynamically from the DB for a given account.
 * Returns the system gmailLabelId values for all labels of type 'system'.
 * Falls back to FALLBACK_SYSTEM_FOLDERS when DB returns empty or throws.
 */
function getSystemFolders(accountId: number): string[] {
  try {
    const db = DatabaseService.getInstance();
    const labels = db.getLabelsByAccount(accountId);
    const systemFolders = labels
      .filter((label) => typeof label['type'] === 'string' && label['type'].toLowerCase() === 'system')
      .map((label) => label['gmailLabelId'] as string)
      .filter((gmailLabelId) => typeof gmailLabelId === 'string' && gmailLabelId.length > 0);
    if (systemFolders.length > 0) {
      return systemFolders;
    }
  } catch {
    // DB not available — fall back to the static list
  }
  return FALLBACK_SYSTEM_FOLDERS;
}

function dedupeStrings(values: string[]): string[] {
  const deduped: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed) {
      continue;
    }
    const normalized = trimmed.toLowerCase();
    if (seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    deduped.push(trimmed);
  }
  return deduped;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isValidDateRange(value: unknown): boolean {
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

function isValidFlags(value: unknown): boolean {
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

function isSearchIntent(value: unknown): value is SearchIntent {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  if (!isStringArray(candidate['keywords'])) {
    return false;
  }
  if (!isStringArray(candidate['synonyms'])) {
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
  if (!isValidDateRange(candidate['dateRange'])) {
    return false;
  }
  if (!isValidFlags(candidate['flags'])) {
    return false;
  }
  if (!isStringArray(candidate['exactPhrases'])) {
    return false;
  }
  if (!isStringArray(candidate['negations'])) {
    return false;
  }
  return true;
}

function buildFolderContext(
  providedFolders: unknown,
  labels: Array<Record<string, unknown>>,
  accountId: number
): string[] {
  const systemFolders = getSystemFolders(accountId);

  if (isStringArray(providedFolders) && providedFolders.length > 0) {
    return dedupeStrings([...systemFolders, ...providedFolders]);
  }

  const customLabels: Array<{ gmailLabelId: string; name: string; totalCount: number }> = [];
  const dbFolders: string[] = [];

  for (const label of labels) {
    const gmailLabelId = typeof label['gmailLabelId'] === 'string' ? label['gmailLabelId'] : '';
    const name = typeof label['name'] === 'string' ? label['name'] : '';
    const type = typeof label['type'] === 'string' ? label['type'] : '';
    const totalCount = typeof label['totalCount'] === 'number' ? label['totalCount'] : 0;

    if (!gmailLabelId && !name) {
      continue;
    }

    const isSystem = type.toLowerCase() === 'system' || systemFolders.includes(gmailLabelId);
    if (isSystem) {
      if (gmailLabelId) {
        dbFolders.push(gmailLabelId);
      }
      if (name) {
        dbFolders.push(name);
      }
      continue;
    }

    customLabels.push({ gmailLabelId, name, totalCount });
  }

  customLabels.sort((a, b) => b.totalCount - a.totalCount);

  const topCustomFolders = customLabels
    .slice(0, 30)
    .flatMap((label) => [label.gmailLabelId, label.name])
    .filter((value) => value.length > 0);

  return dedupeStrings([...systemFolders, ...dbFolders, ...topCustomFolders]);
}

export function registerAiIpcHandlers(): void {
  const ollama = OllamaService.getInstance();

  // Start health checks when IPC handlers are registered
  ollama.startHealthChecks();

  ipcMain.handle(IPC_CHANNELS.AI_SUMMARIZE, async (event, threadContent: string, requestId?: string) => {
    log.info('[AI] summarize request', { requestId, contentLen: threadContent?.length ?? 0 });
    try {
      if (!threadContent || typeof threadContent !== 'string') {
        log.warn('[AI] summarize rejected: invalid input');
        return ipcError('AI_INVALID_INPUT', 'Thread content is required');
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const summary = await ollama.summarizeThread(threadContent, win ?? undefined, requestId);
      log.info('[AI] summarize success', { requestId, summaryLen: summary?.length ?? 0 });
      return ipcSuccess({ summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to summarize thread';
      log.error('[AI] summarize failed', { requestId, message }, err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
      return ipcError('AI_SUMMARIZE_FAILED', message);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AI_COMPOSE,
    async (event, prompt: string, context?: string, requestId?: string) => {
      log.info('[AI] compose request', { requestId, promptLen: prompt?.length ?? 0, hasContext: !!context });
      try {
        if (!prompt || typeof prompt !== 'string') {
          log.warn('[AI] compose rejected: invalid prompt');
          return ipcError('AI_INVALID_INPUT', 'Compose prompt is required');
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await ollama.composeEmail(prompt, context, win ?? undefined, requestId);
        log.info('[AI] compose success', { requestId, resultLen: result?.length ?? 0 });
        return ipcSuccess({ text: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to generate AI composition';
        log.error('[AI] compose failed', { requestId, message }, err);
        if (message.includes('No AI model selected')) {
          return ipcError('AI_NO_MODEL', message);
        }
        return ipcError('AI_COMPOSE_FAILED', message);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.AI_CATEGORIZE, async (_event, emailContent: string) => {
    try {
      if (!emailContent || typeof emailContent !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'Email content is required');
      }
      const category = await ollama.categorizeEmail(emailContent);
      return ipcSuccess({ category });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to categorize email';
      log.error('Failed to categorize:', err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
      return ipcError('AI_CATEGORIZE_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_SEARCH, async (_event, accountId: string, naturalQuery: string, folders?: unknown) => {
    try {
      if (!accountId || isNaN(Number(accountId))) {
        return ipcError('AI_INVALID_INPUT', 'Valid account ID is required');
      }
      if (!naturalQuery || typeof naturalQuery !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'Search query is required');
      }
      if (naturalQuery.length > 2048) {
        return ipcError('AI_INVALID_INPUT', 'Query too long (max 2048 characters)');
      }

      const db = DatabaseService.getInstance();
      const numAccountId = Number(accountId);
      const account = db.getAccountById(numAccountId);
      const userEmail = account?.email || '';
      const todayDate = new Date().toISOString().split('T')[0];
      const labels = db.getLabelsByAccount(numAccountId);
      const folderContext = buildFolderContext(folders, labels, numAccountId);

      log.info('[AI] search request', {
        accountId,
        queryLen: naturalQuery.length,
        userEmail: userEmail ? '(set)' : '(empty)',
        folderCount: folderContext.length,
      });

      let intent: SearchIntent;
      try {
        intent = await ollama.extractSearchIntent(naturalQuery, userEmail, todayDate, folderContext);
      } catch (intentError) {
        log.warn('[AI] search intent extraction failed, falling back to raw query', intentError);
        return ipcSuccess({ intent: null, queries: [naturalQuery], semanticResults: [] });
      }

      if (!isSearchIntent(intent)) {
        log.warn('[AI] search intent validation failed, falling back to raw query');
        return ipcSuccess({ intent: null, queries: [naturalQuery], semanticResults: [] });
      }

      const queries = SearchQueryGenerator.generate(intent);
      if (!Array.isArray(queries) || queries.length === 0) {
        log.warn('[AI] search query generation returned no queries, falling back to raw query');
        return ipcSuccess({ intent: null, queries: [naturalQuery], semanticResults: [] });
      }

      log.info('[AI] search success', {
        accountId,
        queryCount: queries.length,
        direction: intent.direction,
        hasFolder: !!intent.folder,
      });

      // Semantic search is stubbed here and will be fully implemented in Phase 4.
      // For now, always return empty semanticResults so the renderer falls through
      // to keyword search as before.
      return ipcSuccess({ intent, queries, semanticResults: [] });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process natural language search';
      log.error('[AI] search failed:', err);
      return ipcError('AI_SEARCH_FAILED', message);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AI_TRANSFORM,
    async (event, text: string, transformation: string, requestId?: string) => {
      log.info('[AI] transform request', { requestId, transformation, textLen: text?.length ?? 0 });
      try {
        if (!text || typeof text !== 'string') {
          log.warn('[AI] transform rejected: invalid text');
          return ipcError('AI_INVALID_INPUT', 'Text is required');
        }
        if (!transformation || typeof transformation !== 'string') {
          return ipcError('AI_INVALID_INPUT', 'Transformation type is required');
        }
        const validTransformations = ['improve', 'shorten', 'formalize', 'casualize'];
        if (!validTransformations.includes(transformation)) {
          return ipcError('AI_INVALID_INPUT', `Invalid transformation. Must be one of: ${validTransformations.join(', ')}`);
        }
        const win = BrowserWindow.fromWebContents(event.sender);
        const result = await ollama.transformText(text, transformation, win ?? undefined, requestId);
        log.info('[AI] transform success', { requestId, resultLen: result?.length ?? 0 });
        return ipcSuccess({ text: result });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to transform text';
        log.error('[AI] transform failed', { requestId, message }, err);
        if (message.includes('No AI model selected')) {
          return ipcError('AI_NO_MODEL', message);
        }
        return ipcError('AI_TRANSFORM_FAILED', message);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.AI_GET_MODELS, async () => {
    try {
      const models = await ollama.listModels();
      return ipcSuccess({
        models: models.map(m => ({
          name: m.name,
          size: m.size,
          modifiedAt: m.modified_at,
          digest: m.digest,
        })),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to retrieve models';
      log.error('Failed to get AI models:', err);
      return ipcError('AI_GET_MODELS_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_GET_STATUS, async () => {
    try {
      await ollama.checkHealth();
      const status = ollama.getStatus();
      return ipcSuccess(status);
    } catch (err) {
      log.error('Failed to get AI status:', err);
      return ipcSuccess({ connected: false, url: ollama.getStatus().url, currentModel: '' });
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_SET_URL, async (_event, url: string) => {
    try {
      if (!url || typeof url !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'URL is required');
      }
      if (!isAllowedOllamaUrl(url)) {
        return ipcError('AI_INVALID_INPUT', 'Ollama URL must be local (localhost/127.0.0.1/::1) and use http/https');
      }
      await ollama.setUrl(url);
      return ipcSuccess(ollama.getStatus());
    } catch (err) {
      log.error('Failed to set AI URL:', err);
      return ipcError('AI_SET_URL_FAILED', 'Failed to update Ollama URL');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_SET_MODEL, async (_event, model: string) => {
    try {
      if (!model || typeof model !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'Model name is required');
      }
      ollama.setModel(model);
      return ipcSuccess({ currentModel: model });
    } catch (err) {
      log.error('Failed to set AI model:', err);
      return ipcError('AI_SET_MODEL_FAILED', 'Failed to update AI model');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_GENERATE_REPLIES, async (_event, threadContent: string) => {
    log.info('[AI] generate-replies request', { contentLen: threadContent?.length ?? 0 });
    try {
      if (!threadContent || typeof threadContent !== 'string') {
        log.warn('[AI] generate-replies rejected: invalid input');
        return ipcError('AI_INVALID_INPUT', 'Thread content is required');
      }
      const suggestions = await ollama.generateReplySuggestions(threadContent);
      log.info('[AI] generate-replies success', { count: suggestions?.length ?? 0 });
      return ipcSuccess({ suggestions });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate reply suggestions';
      log.error('[AI] generate-replies failed', { message }, err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
      return ipcError('AI_GENERATE_REPLIES_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_GENERATE_FILTER, async (_event, description: string, accountId: number) => {
    log.info('[AI] generate-filter request', { descLen: description?.length ?? 0, accountId });
    try {
      if (!description || typeof description !== 'string') {
        log.warn('[AI] generate-filter rejected: invalid input');
        return ipcError('AI_INVALID_INPUT', 'Filter description is required');
      }
      if (!accountId || typeof accountId !== 'number') {
        return ipcError('AI_INVALID_INPUT', 'Account ID is required');
      }
      const filter = await ollama.generateFilter(description, accountId);
      log.info('[AI] generate-filter success', { name: filter.name, condCount: filter.conditions.length, actionCount: filter.actions.length });
      return ipcSuccess(filter);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate filter';
      log.error('[AI] generate-filter failed', { message }, err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
      return ipcError('AI_GENERATE_FILTER_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_DETECT_FOLLOWUP, async (_event, emailContent: string) => {
    log.info('[AI] detect-followup request', { contentLen: emailContent?.length ?? 0 });
    try {
      if (!emailContent || typeof emailContent !== 'string') {
        log.warn('[AI] detect-followup rejected: invalid input');
        return ipcError('AI_INVALID_INPUT', 'Email content is required');
      }
      const result = await ollama.detectFollowUp(emailContent);
      log.info('[AI] detect-followup success', { needsFollowUp: result.needsFollowUp });
      return ipcSuccess(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to detect follow-up';
      log.error('[AI] detect-followup failed', { message }, err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
      return ipcError('AI_DETECT_FOLLOWUP_FAILED', message);
    }
  });

  // ---- Embedding / Semantic Search handlers ----

  ipcMain.handle(IPC_CHANNELS.AI_SET_EMBEDDING_MODEL, async (_event, model: unknown) => {
    log.info('[AI] set-embedding-model request', { model });
    try {
      if (!model || typeof model !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'Model name is required');
      }
      if (model.length > 256) {
        return ipcError('AI_INVALID_INPUT', 'Model name too long (max 256 characters)');
      }

      // Validate that the model supports the embed endpoint (10s timeout)
      let vectorDimension: number;
      try {
        vectorDimension = await ollama.validateEmbeddingModel(model);
      } catch (validationErr) {
        const message = validationErr instanceof Error ? validationErr.message : 'Model does not support embeddings';
        log.warn('[AI] set-embedding-model validation failed:', { model, message });
        return ipcError('AI_EMBEDDING_MODEL_INVALID', `Model does not support embeddings: ${message}`);
      }

      // Configure vector DB with the new model dimension.
      // Do this BEFORE persisting so that a failure here does not leave the model
      // saved in the DB with an incompatible or un-configured vector table.
      const vectorDb = VectorDbService.getInstance();
      if (vectorDb.vectorsAvailable) {
        const previousModel = vectorDb.getCurrentModel();
        if (previousModel && previousModel !== model) {
          // Model changed — clear existing index and reconfigure
          let embeddingService: EmbeddingService | null = null;
          try {
            embeddingService = EmbeddingService.getInstance();
          } catch {
            // EmbeddingService not initialized — log but continue with vector DB reconfiguration
            log.warn('[AI] set-embedding-model: EmbeddingService not initialized; skipping hash reset');
          }
          if (embeddingService) {
            await embeddingService.onModelChange(model, vectorDimension);
          } else {
            // Fallback: just reconfigure the vector DB without resetting hashes
            vectorDb.clearAllAndReconfigure(model, vectorDimension);
          }
        } else {
          // First-time model set (or same model) — configure dimension
          vectorDb.configureModel(model, vectorDimension);
        }
      }

      // Persist the model only after successful configuration
      ollama.setEmbeddingModel(model);

      log.info('[AI] set-embedding-model success', { model, vectorDimension });
      return ipcSuccess({ embeddingModel: model, vectorDimension });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set embedding model';
      log.error('[AI] set-embedding-model failed:', { message }, err);
      return ipcError('AI_SET_EMBEDDING_MODEL_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_GET_EMBEDDING_STATUS, async () => {
    try {
      const embeddingModel = ollama.getEmbeddingModel();
      const vectorDb = VectorDbService.getInstance();

      let indexStatus: string;
      let indexed = 0;
      let total = 0;

      if (!vectorDb.vectorsAvailable) {
        indexStatus = 'unavailable';
      } else {
        const db = DatabaseService.getInstance();
        const accounts = db.getAccounts().filter((account) => account.is_active);

        for (const account of accounts) {
          const counts = db.countEmbeddingStatus(account.id);
          total += counts.total;
          indexed += counts.embedded;
        }

        if (total === 0 || !embeddingModel) {
          indexStatus = 'not_started';
        } else if (indexed === 0) {
          indexStatus = 'not_started';
        } else if (indexed < total) {
          indexStatus = 'partial';
        } else {
          indexStatus = 'complete';
        }

        // If a build is currently in progress, override the status.
        // Guard the getInstance() call since EmbeddingService may not be initialized yet.
        try {
          const embeddingService = EmbeddingService.getInstance();
          if (embeddingService.getBuildState() === 'building') {
            indexStatus = 'building';
          }
        } catch {
          // EmbeddingService not initialized — treat as not building
        }
      }

      // getVectorDimension() returns null when model is unconfigured — that is safe here
      const vectorDimension = vectorDb.vectorsAvailable ? vectorDb.getVectorDimension() : null;

      log.info('[AI] get-embedding-status', { embeddingModel: embeddingModel || null, indexStatus, indexed, total });
      return ipcSuccess({ embeddingModel: embeddingModel || null, indexStatus, indexed, total, vectorDimension });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to get embedding status';
      log.error('[AI] get-embedding-status failed:', { message }, err);
      return ipcError('AI_GET_EMBEDDING_STATUS_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_BUILD_INDEX, async () => {
    log.info('[AI] build-index request');
    try {
      const embeddingService = EmbeddingService.getInstance();
      embeddingService.startBuild();
      log.info('[AI] build-index started');
      return ipcSuccess({ started: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start index build';
      log.warn('[AI] build-index failed to start:', { message });
      return ipcError('AI_BUILD_INDEX_FAILED', message);
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_CANCEL_INDEX, async () => {
    log.info('[AI] cancel-index request');
    try {
      const embeddingService = EmbeddingService.getInstance();
      embeddingService.cancelBuild();
      log.info('[AI] cancel-index complete');
      return ipcSuccess({ cancelled: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to cancel index build';
      log.error('[AI] cancel-index failed:', { message }, err);
      return ipcError('AI_CANCEL_INDEX_FAILED', message);
    }
  });
}
