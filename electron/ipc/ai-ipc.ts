import { ipcMain } from 'electron';
import log from 'electron-log/main';
import { IPC_CHANNELS, ipcSuccess, ipcError } from './ipc-channels';

export function registerAiIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.AI_SUMMARIZE, async (_event, _threadContent: string) => {
    try {
      // TODO: Implement in Phase 6 with OllamaService
      return ipcError('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
    } catch (err) {
      log.error('Failed to summarize:', err);
      return ipcError('AI_SUMMARIZE_FAILED', 'Failed to summarize thread');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_COMPOSE, async (_event, _prompt: string, _context?: string) => {
    try {
      return ipcError('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
    } catch (err) {
      log.error('Failed to AI compose:', err);
      return ipcError('AI_COMPOSE_FAILED', 'Failed to generate AI composition');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_CATEGORIZE, async (_event, _emailContent: string) => {
    try {
      return ipcError('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
    } catch (err) {
      log.error('Failed to categorize:', err);
      return ipcError('AI_CATEGORIZE_FAILED', 'Failed to categorize email');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_SEARCH, async (_event, _naturalQuery: string) => {
    try {
      return ipcError('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
    } catch (err) {
      log.error('Failed to AI search:', err);
      return ipcError('AI_SEARCH_FAILED', 'Failed to process natural language search');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_TRANSFORM, async (_event, _text: string, _transformation: string) => {
    try {
      return ipcError('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
    } catch (err) {
      log.error('Failed to transform text:', err);
      return ipcError('AI_TRANSFORM_FAILED', 'Failed to transform text');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_GET_MODELS, async () => {
    try {
      return ipcError('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
    } catch (err) {
      log.error('Failed to get AI models:', err);
      return ipcError('AI_GET_MODELS_FAILED', 'Failed to retrieve models');
    }
  });

  ipcMain.handle(IPC_CHANNELS.AI_GET_STATUS, async () => {
    try {
      // TODO: Implement in Phase 6 with OllamaService health check
      return ipcSuccess({ connected: false, url: 'http://localhost:11434' });
    } catch (err) {
      log.error('Failed to get AI status:', err);
      return ipcError('AI_STATUS_FAILED', 'Failed to check AI status');
    }
  });
}
