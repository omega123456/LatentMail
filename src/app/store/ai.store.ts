import { computed, inject } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { AiModel, AiStreamEvent, AiCategory, AiFilterSuggestion, AiFollowUpResult, SearchIntent } from '../core/models/ai.model';

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
  searchResult: { intent: SearchIntent | null; queries: string[] } | null;
  // Filter generation
  filterSuggestion: AiFilterSuggestion | null;
  filterLoading: boolean;
  // Follow-up detection
  followUpResult: AiFollowUpResult | null;
  followUpLoading: boolean;
  // Category cache (threadId → category)
  categoryCache: Record<string, AiCategory>;
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
  searchResult: null,
  filterSuggestion: null,
  filterLoading: false,
  followUpResult: null,
  followUpLoading: false,
  categoryCache: {},
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
            summaryRequestId: null,
          });
        } else {
          if (store.summaryRequestId() !== requestId) {
            return;
          }
          patchState(store, {
            summaryLoading: false,
            summaryRequestId: null,
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
            // Only clear loading; leave summaryRequestId so summarize() can match when IPC resolves
            patchState(store, { summaryLoading: false });
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
            // Only clear loading; leave composeRequestId so aiCompose() can match when IPC resolves
            patchState(store, { composeLoading: false });
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
            // Only clear loading; leave transformRequestId so transform() can match when IPC resolves
            patchState(store, { transformLoading: false });
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
          const text = (response.data as { text: string }).text;
          if (store.composeRequestId() !== requestId) {
            return null;
          }
          patchState(store, {
            composeResult: text,
            composeLoading: false,
            composeRequestId: null,
          });
          return text;
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

      /** Categorize an email and cache the result by thread ID */
      async categorize(threadId: string, emailContent: string): Promise<AiCategory | null> {
        // Check cache first
        const cached = store.categoryCache()[threadId];
        if (cached) {
          return cached;
        }

        patchState(store, { categorizeLoading: true, error: null });
        const response = await electronService.aiCategorize(emailContent);
        if (response.success && response.data) {
          const data = response.data as { category: string };
          const category = (data.category || 'Primary') as AiCategory;
          patchState(store, {
            categorizeResult: category,
            categorizeLoading: false,
            categoryCache: { ...store.categoryCache(), [threadId]: category },
          });
          return category;
        } else {
          patchState(store, {
            categorizeLoading: false,
            error: response.error?.message || 'Failed to categorize',
          });
          return null;
        }
      },

      /** Batch categorize threads (won't re-categorize cached ones) */
      async categorizeThreads(threads: Array<{ threadId: string; content: string }>): Promise<void> {
        const uncached = threads.filter(t => !store.categoryCache()[t.threadId]);
        for (const thread of uncached) {
          await this.categorize(thread.threadId, thread.content);
        }
      },

      /** Get a category from cache */
      getCachedCategory(threadId: string): AiCategory | null {
        return store.categoryCache()[threadId] || null;
      },

      /** Clear category cache */
      clearCategoryCache(): void {
        patchState(store, { categoryCache: {} });
      },

      /** AI search: convert natural language into structured intent + query variants */
      async aiSearch(accountId: string, query: string, folders?: string[]): Promise<{ intent: SearchIntent | null; queries: string[] } | null> {
        patchState(store, { searchLoading: true, searchResult: null, error: null });
        const response = await electronService.aiSearch(accountId, query, folders);
        if (response.success && response.data) {
          const data = response.data as { intent: SearchIntent | null; queries: string[] };
          patchState(store, {
            searchLoading: false,
            searchResult: data,
          });
          return data;
        } else {
          patchState(store, {
            searchLoading: false,
            error: response.error?.message || 'AI search failed',
          });
          return null;
        }
      },

      /** Generate a filter from natural language */
      async generateFilter(description: string, accountId: number): Promise<AiFilterSuggestion | null> {
        patchState(store, { filterLoading: true, filterSuggestion: null, error: null });
        const response = await electronService.aiGenerateFilter(description, accountId);
        if (response.success && response.data) {
          const data = response.data as AiFilterSuggestion;
          patchState(store, {
            filterLoading: false,
            filterSuggestion: data,
          });
          return data;
        } else {
          patchState(store, {
            filterLoading: false,
            error: response.error?.message || 'Failed to generate filter',
          });
          return null;
        }
      },

      /** Clear filter suggestion */
      clearFilterSuggestion(): void {
        patchState(store, { filterSuggestion: null, filterLoading: false });
      },

      /** Detect follow-up need for a sent email */
      async detectFollowUp(emailContent: string): Promise<AiFollowUpResult | null> {
        patchState(store, { followUpLoading: true, followUpResult: null, error: null });
        const response = await electronService.aiDetectFollowUp(emailContent);
        if (response.success && response.data) {
          const data = response.data as AiFollowUpResult;
          patchState(store, {
            followUpLoading: false,
            followUpResult: data,
          });
          return data;
        } else {
          patchState(store, {
            followUpLoading: false,
            error: response.error?.message || 'Failed to detect follow-up',
          });
          return null;
        }
      },

      /** Clear follow-up result */
      clearFollowUp(): void {
        patchState(store, { followUpResult: null, followUpLoading: false });
      },

      /** Clear search result */
      clearSearchResult(): void {
        patchState(store, { searchResult: null, searchLoading: false });
      },
    };
  })
);
