import { ipcMain, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { OllamaService } from '../services/ollama-service';
import { DatabaseService } from '../services/database-service';

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

  ipcMain.handle(IPC_CHANNELS.AI_SEARCH, async (_event, accountId: string, naturalQuery: string) => {
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

      // Retrieve user email from database for context
      const db = DatabaseService.getInstance();
      const account = db.getAccountById(Number(accountId));
      const userEmail = account?.email || '';
      const todayDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD

      log.info('[AI] search request', { accountId, queryLen: naturalQuery.length, userEmail: userEmail ? '(set)' : '(empty)' });
      const result = await ollama.naturalLanguageSearch(naturalQuery, userEmail, todayDate);
      log.info('[AI] search success', { query: result.query });
      return ipcSuccess(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process natural language search';
      log.error('[AI] search failed:', err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
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
