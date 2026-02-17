import { ipcMain, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';
import { OllamaService } from '../services/ollama-service';

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
    try {
      if (!threadContent || typeof threadContent !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'Thread content is required');
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const summary = await ollama.summarizeThread(threadContent, win ?? undefined, requestId);
      return ipcSuccess({ summary });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to summarize thread';
      log.error('Failed to summarize:', err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
      return ipcError('AI_SUMMARIZE_FAILED', message);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AI_COMPOSE,
    async (event, prompt: string, context?: string, requestId?: string) => {
    try {
      if (!prompt || typeof prompt !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'Compose prompt is required');
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await ollama.composeEmail(prompt, context, win ?? undefined, requestId);
      return ipcSuccess({ text: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate AI composition';
      log.error('Failed to AI compose:', err);
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

  ipcMain.handle(IPC_CHANNELS.AI_SEARCH, async (_event, naturalQuery: string) => {
    try {
      if (!naturalQuery || typeof naturalQuery !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'Search query is required');
      }
      const result = await ollama.naturalLanguageSearch(naturalQuery);
      return ipcSuccess(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to process natural language search';
      log.error('Failed to AI search:', err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
      return ipcError('AI_SEARCH_FAILED', message);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AI_TRANSFORM,
    async (event, text: string, transformation: string, requestId?: string) => {
    try {
      if (!text || typeof text !== 'string') {
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
      return ipcSuccess({ text: result });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to transform text';
      log.error('Failed to transform text:', err);
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
    try {
      if (!threadContent || typeof threadContent !== 'string') {
        return ipcError('AI_INVALID_INPUT', 'Thread content is required');
      }
      const suggestions = await ollama.generateReplySuggestions(threadContent);
      return ipcSuccess({ suggestions });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to generate reply suggestions';
      log.error('Failed to generate replies:', err);
      if (message.includes('No AI model selected')) {
        return ipcError('AI_NO_MODEL', message);
      }
      return ipcError('AI_GENERATE_REPLIES_FAILED', message);
    }
  });
}
