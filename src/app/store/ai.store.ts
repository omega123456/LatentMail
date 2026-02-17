import { computed, inject } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { AiModel, AiStreamEvent } from '../core/models/ai.model';

export interface AiState {
  connected: boolean;
  url: string;
  currentModel: string;
  availableModels: AiModel[];
  // Summarize
  summaryText: string;
  summaryLoading: boolean;
  summaryThreadId: string | null;
  summaryRequestId: string | null;
  // Reply suggestions
  replySuggestions: string[];
  replySuggestionsLoading: boolean;
  // Compose
  composeResult: string;
  composeLoading: boolean;
  composeRequestId: string | null;
  // Transform
  transformResult: string;
  transformLoading: boolean;
  transformRequestId: string | null;
  // Categorize
  categorizeResult: string;
  categorizeLoading: boolean;
  // Search
  searchLoading: boolean;
  // General
  error: string | null;
  modelsLoading: boolean;
}

const initialState: AiState = {
  connected: false,
  url: 'http://localhost:11434',
  currentModel: '',
  availableModels: [],
  summaryText: '',
  summaryLoading: false,
  summaryThreadId: null,
  summaryRequestId: null,
  replySuggestions: [],
  replySuggestionsLoading: false,
  composeResult: '',
  composeLoading: false,
  composeRequestId: null,
  transformResult: '',
  transformLoading: false,
  transformRequestId: null,
  categorizeResult: '',
  categorizeLoading: false,
  searchLoading: false,
  error: null,
  modelsLoading: false,
};

export const AiStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((store) => ({
    isAvailable: computed(() => store.connected() && store.currentModel() !== ''),
    hasModels: computed(() => store.availableModels().length > 0),
    statusLabel: computed(() => {
      if (!store.connected()) {
        return 'Ollama: Disconnected';
      }
      if (!store.currentModel()) {
        return 'Ollama: No model selected';
      }
      return `Ollama: ${store.currentModel()}`;
    }),
  })),
  withMethods((store) => {
    const electronService = inject(ElectronService);

    return {
      /** Check AI connection status */
      async checkStatus(): Promise<void> {
        const response = await electronService.aiGetStatus();
        if (response.success && response.data) {
          const data = response.data as { connected: boolean; url: string; currentModel: string };
          patchState(store, {
            connected: data.connected,
            url: data.url,
            currentModel: data.currentModel || '',
          });
        }
      },

      /** Update connection status from push event */
      updateStatus(status: { connected: boolean; url: string; currentModel: string }): void {
        patchState(store, {
          connected: status.connected,
          url: status.url,
          currentModel: status.currentModel || store.currentModel(),
        });
      },

      /** Load available models */
      async loadModels(): Promise<void> {
        patchState(store, { modelsLoading: true, error: null });
        const response = await electronService.aiGetModels();
        if (response.success && response.data) {
          const data = response.data as { models: AiModel[] };
          patchState(store, {
            availableModels: data.models || [],
            modelsLoading: false,
          });
        } else {
          patchState(store, {
            modelsLoading: false,
            error: response.error?.message || 'Failed to load models',
          });
        }
      },

      /** Set Ollama URL */
      async setUrl(url: string): Promise<void> {
        patchState(store, { error: null });
        const response = await electronService.aiSetUrl(url);
        if (response.success && response.data) {
          const data = response.data as { connected: boolean; url: string; currentModel: string };
          patchState(store, {
            connected: data.connected,
            url: data.url,
          });
        } else {
          patchState(store, {
            error: response.error?.message || 'Failed to update URL',
          });
        }
      },

      /** Set AI model */
      async setModel(model: string): Promise<void> {
        patchState(store, { error: null });
        const response = await electronService.aiSetModel(model);
        if (response.success) {
          patchState(store, { currentModel: model });
        } else {
          patchState(store, {
            error: response.error?.message || 'Failed to set model',
          });
        }
      },

      /** Summarize a thread */
      async summarize(threadId: string, threadContent: string): Promise<void> {
        const requestId = crypto.randomUUID();
        patchState(store, {
          summaryText: '',
          summaryLoading: true,
          summaryThreadId: threadId,
          summaryRequestId: requestId,
          error: null,
        });
        const response = await electronService.aiSummarize(threadContent, requestId);
        if (response.success && response.data) {
          const data = response.data as { summary: string };
          if (store.summaryRequestId() !== requestId) {
            return;
          }
          patchState(store, {
            summaryText: data.summary,
            summaryLoading: false,
          });
        } else {
          if (store.summaryRequestId() !== requestId) {
            return;
          }
          patchState(store, {
            summaryLoading: false,
            error: response.error?.message || 'Failed to summarize',
          });
        }
      },

      /** Handle streaming token for summary */
      appendStreamToken(event: AiStreamEvent): void {
        if (event.type === 'summarize') {
          if (event.requestId && store.summaryRequestId() && event.requestId !== store.summaryRequestId()) {
            return;
          }
          if (event.done) {
            patchState(store, { summaryLoading: false, summaryRequestId: null });
          } else {
            patchState(store, {
              summaryText: store.summaryText() + event.token,
            });
          }
        } else if (event.type === 'compose') {
          if (event.requestId && store.composeRequestId() && event.requestId !== store.composeRequestId()) {
            return;
          }
          if (event.done) {
            patchState(store, { composeLoading: false, composeRequestId: null });
          } else {
            patchState(store, {
              composeResult: store.composeResult() + event.token,
            });
          }
        } else if (event.type === 'transform') {
          if (event.requestId && store.transformRequestId() && event.requestId !== store.transformRequestId()) {
            return;
          }
          if (event.done) {
            patchState(store, { transformLoading: false, transformRequestId: null });
          } else {
            patchState(store, {
              transformResult: store.transformResult() + event.token,
            });
          }
        }
      },

      /** Generate reply suggestions */
      async generateReplies(threadContent: string): Promise<void> {
        patchState(store, {
          replySuggestions: [],
          replySuggestionsLoading: true,
          error: null,
        });
        const response = await electronService.aiGenerateReplies(threadContent);
        if (response.success && response.data) {
          const data = response.data as { suggestions: string[] };
          patchState(store, {
            replySuggestions: data.suggestions || [],
            replySuggestionsLoading: false,
          });
        } else {
          patchState(store, {
            replySuggestionsLoading: false,
            error: response.error?.message || 'Failed to generate replies',
          });
        }
      },

      /** AI compose */
      async aiCompose(prompt: string, context?: string): Promise<string | null> {
        const requestId = crypto.randomUUID();
        patchState(store, {
          composeResult: '',
          composeLoading: true,
          composeRequestId: requestId,
          error: null,
        });
        const response = await electronService.aiCompose(prompt, context, requestId);
        if (response.success && response.data) {
          const data = response.data as { text: string };
          if (store.composeRequestId() !== requestId) {
            return null;
          }
          patchState(store, {
            composeResult: data.text,
            composeLoading: false,
            composeRequestId: null,
          });
          return data.text;
        } else {
          if (store.composeRequestId() !== requestId) {
            return null;
          }
          patchState(store, {
            composeLoading: false,
            composeRequestId: null,
            error: response.error?.message || 'Failed to compose',
          });
          return null;
        }
      },

      /** Transform text */
      async transform(text: string, transformation: string): Promise<string | null> {
        const requestId = crypto.randomUUID();
        patchState(store, {
          transformResult: '',
          transformLoading: true,
          transformRequestId: requestId,
          error: null,
        });
        const response = await electronService.aiTransform(text, transformation, requestId);
        if (response.success && response.data) {
          const data = response.data as { text: string };
          if (store.transformRequestId() !== requestId) {
            return null;
          }
          patchState(store, {
            transformResult: data.text,
            transformLoading: false,
            transformRequestId: null,
          });
          return data.text;
        } else {
          if (store.transformRequestId() !== requestId) {
            return null;
          }
          patchState(store, {
            transformLoading: false,
            transformRequestId: null,
            error: response.error?.message || 'Failed to transform text',
          });
          return null;
        }
      },

      /** Clear summary */
      clearSummary(): void {
        patchState(store, {
          summaryText: '',
          summaryLoading: false,
          summaryThreadId: null,
          summaryRequestId: null,
        });
      },

      /** Clear reply suggestions */
      clearReplies(): void {
        patchState(store, {
          replySuggestions: [],
          replySuggestionsLoading: false,
        });
      },

      /** Clear error */
      clearError(): void {
        patchState(store, { error: null });
      },
    };
  })
);
