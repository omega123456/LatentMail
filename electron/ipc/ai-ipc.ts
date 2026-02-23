import { ipcMain, BrowserWindow } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

const log = LoggerService.getInstance();
import { OllamaService } from '../services/ollama-service';
import { DatabaseService } from '../services/database-service';
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

const SYSTEM_FOLDERS = [
  'INBOX',
  '[Gmail]/Sent Mail',
  '[Gmail]/Drafts',
  '[Gmail]/Trash',
  '[Gmail]/Spam',
  '[Gmail]/Starred',
  '[Gmail]/Important',
];

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
  labels: Array<Record<string, unknown>>
): string[] {
  if (isStringArray(providedFolders) && providedFolders.length > 0) {
    return dedupeStrings([...SYSTEM_FOLDERS, ...providedFolders]);
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

    const isSystem = type.toLowerCase() === 'system' || SYSTEM_FOLDERS.includes(gmailLabelId);
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

  return dedupeStrings([...SYSTEM_FOLDERS, ...dbFolders, ...topCustomFolders]);
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
      const folderContext = buildFolderContext(folders, labels);

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
        return ipcSuccess({ intent: null, queries: [naturalQuery] });
      }

      if (!isSearchIntent(intent)) {
        log.warn('[AI] search intent validation failed, falling back to raw query');
        return ipcSuccess({ intent: null, queries: [naturalQuery] });
      }

      const queries = SearchQueryGenerator.generate(intent);
      if (!Array.isArray(queries) || queries.length === 0) {
        log.warn('[AI] search query generation returned no queries, falling back to raw query');
        return ipcSuccess({ intent: null, queries: [naturalQuery] });
      }

      log.info('[AI] search success', {
        accountId,
        queryCount: queries.length,
        direction: intent.direction,
        hasFolder: !!intent.folder,
      });
      return ipcSuccess({ intent, queries });
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
}
