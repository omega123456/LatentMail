"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerAiIpcHandlers = registerAiIpcHandlers;
const electron_1 = require("electron");
const main_1 = __importDefault(require("electron-log/main"));
const ipc_channels_1 = require("./ipc-channels");
function registerAiIpcHandlers() {
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AI_SUMMARIZE, async (_event, _threadContent) => {
        try {
            // TODO: Implement in Phase 6 with OllamaService
            return (0, ipc_channels_1.ipcError)('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
        }
        catch (err) {
            main_1.default.error('Failed to summarize:', err);
            return (0, ipc_channels_1.ipcError)('AI_SUMMARIZE_FAILED', 'Failed to summarize thread');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AI_COMPOSE, async (_event, _prompt, _context) => {
        try {
            return (0, ipc_channels_1.ipcError)('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
        }
        catch (err) {
            main_1.default.error('Failed to AI compose:', err);
            return (0, ipc_channels_1.ipcError)('AI_COMPOSE_FAILED', 'Failed to generate AI composition');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AI_CATEGORIZE, async (_event, _emailContent) => {
        try {
            return (0, ipc_channels_1.ipcError)('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
        }
        catch (err) {
            main_1.default.error('Failed to categorize:', err);
            return (0, ipc_channels_1.ipcError)('AI_CATEGORIZE_FAILED', 'Failed to categorize email');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AI_SEARCH, async (_event, _naturalQuery) => {
        try {
            return (0, ipc_channels_1.ipcError)('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
        }
        catch (err) {
            main_1.default.error('Failed to AI search:', err);
            return (0, ipc_channels_1.ipcError)('AI_SEARCH_FAILED', 'Failed to process natural language search');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AI_TRANSFORM, async (_event, _text, _transformation) => {
        try {
            return (0, ipc_channels_1.ipcError)('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
        }
        catch (err) {
            main_1.default.error('Failed to transform text:', err);
            return (0, ipc_channels_1.ipcError)('AI_TRANSFORM_FAILED', 'Failed to transform text');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AI_GET_MODELS, async () => {
        try {
            return (0, ipc_channels_1.ipcError)('AI_OLLAMA_UNAVAILABLE', 'Ollama is not connected');
        }
        catch (err) {
            main_1.default.error('Failed to get AI models:', err);
            return (0, ipc_channels_1.ipcError)('AI_GET_MODELS_FAILED', 'Failed to retrieve models');
        }
    });
    electron_1.ipcMain.handle(ipc_channels_1.IPC_CHANNELS.AI_GET_STATUS, async () => {
        try {
            // TODO: Implement in Phase 6 with OllamaService health check
            return (0, ipc_channels_1.ipcSuccess)({ connected: false, url: 'http://localhost:11434' });
        }
        catch (err) {
            main_1.default.error('Failed to get AI status:', err);
            return (0, ipc_channels_1.ipcError)('AI_STATUS_FAILED', 'Failed to check AI status');
        }
    });
}
//# sourceMappingURL=ai-ipc.js.map