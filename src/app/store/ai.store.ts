import { computed, inject } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState, withHooks } from '@ngrx/signals';
import { ElectronService, SearchBatchPayload, SearchCompletePayload } from '../core/services/electron.service';
import { ToastService } from '../core/services/toast.service';
import { AiModel, AiStreamEvent, AiFilterSuggestion, AiFollowUpResult, SearchIntent } from '../core/models/ai.model';
import { EmbeddingProgressPayload, EmbeddingErrorPayload, EmbeddingStatusData } from '../core/services/electron.service';
import { Thread } from '../core/models/email.model';
import { EmailsStore } from './emails.store';

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
  replySuggestionsThreadId: string | null;
  // Compose
  composeResult: string;
  composeLoading: boolean;
  composeRequestId: string | null;
  // Transform
  transformResult: string;
  transformLoading: boolean;
  transformRequestId: string | null;
  // Search
  searchLoading: boolean;
  searchResult: { intent: SearchIntent | null; queries: string[] } | null;
  // Streaming search state
  searchToken: string | null;
  /**
   * True while a new search has been started but the IPC response (carrying the real
   * searchToken) has not yet been received. During this window, `onSearchBatch` and
   * `onSearchComplete` should adopt the first incoming token rather than rejecting it
   * as "stale", because the real token has not yet been written to the store.
   */
  searchTokenPending: boolean;
  searchStreamStatus: 'idle' | 'searching' | 'complete' | 'partial' | 'error';
  searchStreamResultCount: number;
  searchStreamWarningDismissed: boolean;
  searchAccountId: string | null;
  isNavigationSearch: boolean;
  /**
   * Set of search tokens that have been explicitly superseded by a new navigation
   * search. Events carrying a token in this set are always rejected, even if they
   * arrive while `searchTokenPending` is true (i.e. before the IPC response for the
   * new search has been received). This closes the race window left by the guard-token
   * approach, where new-search events arriving before the IPC response were rejected
   * because they did not match the guard UUID.
   *
   * Tokens are added here at the moment `startNavigationSearch()` resets state.
   * The set is cleared when the streaming search is fully reset (`clearStreamingSearch`).
   */
  rejectedTokens: ReadonlySet<string>;
  /**
   * Monotonically increasing counter, incremented on each call to startNavigationSearch().
   * Captured before the async IPC call; if the counter has changed by the time the IPC
   * response arrives, a superseding navigation has already started and the response is
   * discarded. Also guards the token-adoption path in onSearchBatch/onSearchComplete: only
   * adopt an incoming token if the current generation matches the generation captured at
   * the moment the pending window opened. This prevents the edge case where two navigation
   * searches fire before either receives its IPC response — the first response's token
   * cannot be adopted by the second search's pending window.
   */
  navigationGeneration: number;
  // Filter generation
  filterSuggestion: AiFilterSuggestion | null;
  filterLoading: boolean;
  // Follow-up detection
  followUpResult: AiFollowUpResult | null;
  followUpLoading: boolean;
  followUpThreadId: string | null;
  // Embedding / Semantic Search
  embeddingModel: string;
  embeddingModels: AiModel[];
  embeddingModelsLoading: boolean;
  indexStatus: 'not_started' | 'building' | 'complete' | 'partial' | 'unavailable';
  indexProgress: { indexed: number; total: number; percent: number } | null;
  indexError: string | null;
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
  replySuggestionsThreadId: null,
  composeResult: '',
  composeLoading: false,
  composeRequestId: null,
  transformResult: '',
  transformLoading: false,
  transformRequestId: null,
  searchLoading: false,
  searchResult: null,
  // Streaming search state
  searchToken: null,
  searchTokenPending: false,
  searchStreamStatus: 'idle',
  searchStreamResultCount: 0,
  searchStreamWarningDismissed: false,
  searchAccountId: null,
  isNavigationSearch: false,
  rejectedTokens: new Set<string>() as ReadonlySet<string>,
  navigationGeneration: 0,
  filterSuggestion: null,
  filterLoading: false,
  followUpResult: null,
  followUpLoading: false,
  followUpThreadId: null,
  error: null,
  modelsLoading: false,
  // Embedding / Semantic Search
  embeddingModel: '',
  embeddingModels: [],
  embeddingModelsLoading: false,
  indexStatus: 'not_started',
  indexProgress: null,
  indexError: null,
};

export const AiStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((store) => ({
    isAvailable: computed(() => store.connected() && store.currentModel() !== ''),
    isEmbeddingAvailable: computed(() => store.connected() && store.embeddingModel() !== ''),
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
    const emailsStore = inject(EmailsStore);

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
        // Also refresh embedding status whenever AI status is checked
        const embeddingResponse = await electronService.aiGetEmbeddingStatus();
        if (embeddingResponse.success && embeddingResponse.data) {
          const embData = embeddingResponse.data as EmbeddingStatusData;
          let indexProgress: { indexed: number; total: number; percent: number } | null = null;
          if (embData.indexed > 0) {
            if (embData.total > 0) {
              indexProgress = { indexed: embData.indexed, total: embData.total, percent: Math.round((embData.indexed / embData.total) * 100) };
            } else {
              // total === 0 outside of a build: index exists but total is unknown
              indexProgress = { indexed: embData.indexed, total: 0, percent: 100 };
            }
          }
          patchState(store, {
            embeddingModel: embData.embeddingModel || '',
            indexStatus: (embData.indexStatus as AiState['indexStatus']) || 'not_started',
            indexProgress,
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
      async generateReplies(threadContent: string, threadId?: string): Promise<void> {
        patchState(store, {
          replySuggestions: [],
          replySuggestionsLoading: true,
          replySuggestionsThreadId: threadId ?? null,
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
            replySuggestionsThreadId: null,
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
          replySuggestionsThreadId: null,
        });
      },

      /** Clear error */
      clearError(): void {
        patchState(store, { error: null });
      },

      /** AI search: convert natural language into structured intent + query variants */
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
      async detectFollowUp(emailContent: string, threadId?: string): Promise<AiFollowUpResult | null> {
        patchState(store, {
          followUpLoading: true,
          followUpResult: null,
          followUpThreadId: threadId ?? null,
          error: null,
        });
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
            followUpThreadId: null,
            error: response.error?.message || 'Failed to detect follow-up',
          });
          return null;
        }
      },

      /** Clear follow-up result */
      clearFollowUp(): void {
        patchState(store, { followUpResult: null, followUpLoading: false, followUpThreadId: null });
      },

      /** Clear search result */
      clearSearchResult(): void {
        patchState(store, { searchResult: null, searchLoading: false });
      },

      // ─── Streaming Search ──────────────────────────────────────────

      /**
       * Start a streaming semantic search.
       * Resets all prior streaming state, invokes ai:search (which now returns a
       * searchToken immediately), and patches the token into the store.
       * Actual results arrive as push events (ai:search:batch / ai:search:complete).
       *
       * Returns { searchToken, query } so the caller knows the search started,
       * or null if already searching (search lock) or if the IPC call fails.
       */
      async startStreamingSearch(
        accountId: string,
        query: string,
        folders?: string[],
        mode?: 'keyword' | 'semantic',
      ): Promise<{ searchToken: string; query: string } | null> {
        // Search lock — prevent concurrent searches
        if (store.searchStreamStatus() === 'searching') {
          return null;
        }

        // Reset all prior streaming state before starting
        patchState(store, {
          searchToken: null,
          searchTokenPending: true,
          searchStreamStatus: 'searching',
          searchStreamResultCount: 0,
          searchStreamWarningDismissed: false,
          searchAccountId: accountId,
          isNavigationSearch: false,
        });

        try {
          const response = await electronService.aiSearch(accountId, query, folders, mode);
          if (response.success && response.data) {
            const data = response.data as { searchToken: string };
            patchState(store, { searchToken: data.searchToken, searchTokenPending: false });
            return { searchToken: data.searchToken, query };
          } else {
            patchState(store, { searchStreamStatus: 'error', searchTokenPending: false });
            return null;
          }
        } catch {
          patchState(store, { searchStreamStatus: 'error', searchTokenPending: false });
          return null;
        }
      },

      /**
       * Handle an incoming ai:search:batch push event.
       * Resolves the batch of msgIds to Thread objects and merges them into the
       * emails store. Silently ignores events for stale search tokens.
       *
       * If the batch arrives before the IPC response (token not set yet), we adopt
       * the batch's token so we don't drop results due to IPC ordering.
       */
      async onSearchBatch(payload: SearchBatchPayload): Promise<void> {
        // Always reject tokens that have been explicitly superseded by a new navigation
        // search, regardless of pending state. This handles the race where stale events
        // arrive after startNavigationSearch() resets state but before the IPC response.
        if (store.rejectedTokens().has(payload.searchToken)) {
          return;
        }

        // Ignore only when we already have a confirmed token that does not match
        // (stale event from a previous search).
        const currentToken = store.searchToken();
        const isPending = store.searchTokenPending();

        if (currentToken != null && !isPending && payload.searchToken !== currentToken) {
          return;
        }

        // If the store is still waiting for the IPC response (searchTokenPending) or
        // the token has not been set yet, adopt the first incoming batch token.
        // This prevents the race where the batch push event arrives before the IPC
        // promise resolves and writes the real token.
        if (isPending || currentToken == null) {
          patchState(store, { searchToken: payload.searchToken, searchTokenPending: false });
        }

        // Empty batch (e.g. empty local phase) — nothing to merge
        if (payload.msgIds.length === 0) {
          return;
        }

        const currentAccountId = store.searchAccountId();
        if (!currentAccountId) {
          return;
        }

        try {
          const response = await electronService.searchEmailsByMsgIds(currentAccountId, payload.msgIds);
          if (response.success && response.data) {
            const resolvedThreads = response.data as Thread[];
            emailsStore.appendStreamingBatch(resolvedThreads);
            // Use the merged thread count as the displayed count — deduplication in
            // appendStreamingBatch means resolved batch size may exceed new unique threads.
            patchState(store, {
              searchStreamResultCount: emailsStore.threads().length,
            });
          }
        } catch {
          // Swallow batch resolution errors — partial batch failure should not break
          // the streaming flow; remaining batches will continue to arrive normally.
        }
      },

      /**
       * Handle an incoming ai:search:complete push event.
       * Transitions searchStreamStatus to the final status reported by the backend.
       * Silently ignores events for stale search tokens.
       *
       * If complete arrives before we had a token (batch arrived after complete), adopt token.
       */
      onSearchComplete(payload: SearchCompletePayload): void {
        // Always reject tokens that have been explicitly superseded by a new navigation
        // search, regardless of pending state (mirrors onSearchBatch rejection logic).
        if (store.rejectedTokens().has(payload.searchToken)) {
          return;
        }

        const currentToken = store.searchToken();
        const isPending = store.searchTokenPending();

        if (currentToken != null && !isPending && payload.searchToken !== currentToken) {
          return;
        }
        // Adopt token if still pending or not yet set (mirrors onSearchBatch logic).
        if (isPending || currentToken == null) {
          patchState(store, { searchToken: payload.searchToken, searchTokenPending: false });
        }

        patchState(store, { searchStreamStatus: payload.status });
      },

      /** Reset all streaming search state to idle. Call on search clear/dismiss. */
      clearStreamingSearch(): void {
        patchState(store, {
          searchToken: null,
          searchTokenPending: false,
          searchStreamStatus: 'idle',
          searchStreamResultCount: 0,
          searchStreamWarningDismissed: false,
          searchAccountId: null,
          isNavigationSearch: false,
          // Clear rejected tokens so the set does not grow unboundedly across
          // multiple navigation searches within a single session.
          rejectedTokens: new Set<string>() as ReadonlySet<string>,
        });
      },

      /** Dismiss the partial/error warning banner shown during streaming search. */
      dismissSearchWarning(): void {
        patchState(store, { searchStreamWarningDismissed: true });
      },

      /**
       * Reset only the isNavigationSearch flag without touching any other search state.
       * Called by the auto-select effect in mail-shell after it triggers loadThread(), so
       * the effect does not fire again on subsequent thread-list updates.
       */
      clearNavigationFlag(): void {
        patchState(store, { isNavigationSearch: false });
      },

      /**
       * Start a navigation search for a single email by its x_gm_msgid.
       * Resets all prior streaming state, calls ai:chat:navigate (which fires the search
       * in the background and returns a searchToken immediately), and primes the store.
       * Actual results arrive as push events (ai:search:batch / ai:search:complete).
        *
        * Returns the searchToken on success, or null if the IPC call fails.
        *
        * Race-condition handling: the old token (if any) is added to `rejectedTokens`
        * BEFORE state is reset. This means stale push events carrying the old token are
        * always dropped, even if they arrive during the `searchTokenPending` window
        * (before the IPC response for the new search has been received). The new search's
        * events carry an unknown-but-different token and are safely adopted via the
        * `searchTokenPending: true` path in onSearchBatch / onSearchComplete.
        *
        * The edge case of two simultaneous navigations both pending (no token yet for
        * either) is architecturally impossible: the IPC handler (ai-ipc.ts) generates
        * the token and returns it synchronously via ipcSuccess BEFORE launching
        * runStreamingSearch as a fire-and-forget .catch() chain. By the time any
        * ai:search:batch push event can arrive in the renderer, the IPC response has
        * already resolved and the real token is set in the store. The navigationGeneration
        * guard in this function provides an additional layer of safety for this case.
        */
      async startNavigationSearch(
        accountId: number,
        xGmMsgId: string,
      ): Promise<string | null> {
        // Step 1: Snapshot the old token and add it to the rejected set so any
        // still-in-flight push events from the previous search are always ignored,
        // even if they arrive while searchTokenPending is true.
        const oldToken = store.searchToken();
        const currentRejected = store.rejectedTokens();
        const nextRejected = new Set<string>(currentRejected) as ReadonlySet<string>;
        if (oldToken) {
          (nextRejected as Set<string>).add(oldToken);
        }

        // Step 2: Increment the navigation generation counter. This handles the
        // edge case where two navigation searches fire before either receives its
        // IPC response (searchToken still null). The generation counter ensures
        // only the latest navigation can adopt an incoming token via the pending path.
        const thisGeneration = store.navigationGeneration() + 1;

        // Step 3: Reset state. searchToken: null + searchTokenPending: true means
        // onSearchBatch / onSearchComplete will adopt the first incoming token that
        // is NOT in rejectedTokens AND matches the current navigationGeneration.
        patchState(store, {
          rejectedTokens: nextRejected,
          navigationGeneration: thisGeneration,
          searchToken: null,
          searchTokenPending: true,
          searchStreamStatus: 'searching',
          searchStreamResultCount: 0,
          searchStreamWarningDismissed: false,
          searchAccountId: String(accountId),
          isNavigationSearch: true,
        });

        // Step 4: Start the navigation search via IPC.
        try {
          const response = await electronService.aiChatNavigate(accountId, xGmMsgId);
          if (response.success && response.data) {
            const data = response.data as { searchToken: string };
            // Guard: if a superseding navigation started while we were awaiting, discard.
            if (store.navigationGeneration() !== thisGeneration) {
              return null;
            }
            // Only write the confirmed token if we are still in pending state.
            // If the token was already adopted from a batch event that arrived before
            // the IPC response, searchTokenPending will already be false — don't
            // overwrite the adopted token (it's the same value, but be explicit).
            if (store.searchTokenPending()) {
              patchState(store, { searchToken: data.searchToken, searchTokenPending: false });
            }
            return data.searchToken;
          } else {
            patchState(store, { searchStreamStatus: 'error', searchTokenPending: false, isNavigationSearch: false });
            return null;
          }
        } catch {
          patchState(store, { searchStreamStatus: 'error', searchTokenPending: false, isNavigationSearch: false });
          return null;
        }
      },

      // ─── Embedding / Semantic Search ───────────────────────────────

      /** Load embedding status from backend and patch store */
      async loadEmbeddingStatus(): Promise<void> {
        const response = await electronService.aiGetEmbeddingStatus();
        if (response.success && response.data) {
          const embData = response.data as EmbeddingStatusData;
          const indexStatus = (embData.indexStatus as AiState['indexStatus']) || 'not_started';
          let indexProgress: { indexed: number; total: number; percent: number } | null = null;
          if (embData.indexed > 0) {
            if (embData.total > 0) {
              // Active build with known total: show deterministic progress
              indexProgress = { indexed: embData.indexed, total: embData.total, percent: Math.round((embData.indexed / embData.total) * 100) };
            } else {
              // Outside build (total === 0 signals "unknown total"): show indexed count only,
              // percent = 100 so the progress bar appears filled
              indexProgress = { indexed: embData.indexed, total: 0, percent: 100 };
            }
          }
          patchState(store, {
            embeddingModel: embData.embeddingModel || '',
            indexStatus,
            indexProgress,
          });
        }
      },

      /** Set the embedding model (validates with backend test embed call) */
      async setEmbeddingModel(model: string): Promise<boolean> {
        patchState(store, { error: null, indexError: null });
        const response = await electronService.aiSetEmbeddingModel(model);
        if (response.success) {
          patchState(store, { embeddingModel: model });
          return true;
        } else {
          patchState(store, {
            error: response.error?.message || 'Model does not support embeddings',
          });
          return false;
        }
      },

      /** Load the list of models available for embedding (same model list as chat models) */
      async loadEmbeddingModels(): Promise<void> {
        patchState(store, { embeddingModelsLoading: true });
        const response = await electronService.aiGetModels();
        if (response.success && response.data) {
          const data = response.data as { models: AiModel[] };
          patchState(store, {
            embeddingModels: data.models || [],
            embeddingModelsLoading: false,
          });
        } else {
          patchState(store, {
            embeddingModels: [],
            embeddingModelsLoading: false,
          });
        }
      },

      /** Trigger a full index build */
      async buildIndex(): Promise<void> {
        patchState(store, { indexError: null, error: null, indexProgress: null });
        const response = await electronService.aiBuildIndex();
        if (response.success) {
          patchState(store, { indexStatus: 'building' });
        } else {
          patchState(store, {
            indexError: response.error?.message || 'Failed to start index build',
          });
        }
      },

      /** Wipe index state and start full reindex (after user confirmation). */
      async rebuildAllIndex(): Promise<void> {
        patchState(store, { indexError: null, error: null, indexProgress: null });
        const response = await electronService.aiRebuildIndex();
        if (response.success) {
          patchState(store, { indexStatus: 'building' });
        } else {
          patchState(store, {
            indexError: response.error?.message || 'Failed to start rebuild',
          });
        }
      },

      /** Cancel an in-progress index build */
      async cancelIndex(): Promise<void> {
        const response = await electronService.aiCancelIndex();
        if (response.success) {
          patchState(store, { indexStatus: 'partial' });
        }
      },

      /** Handle embedding:progress push event */
      onEmbeddingProgress(payload: EmbeddingProgressPayload): void {
        patchState(store, {
          indexStatus: 'building',
          indexProgress: { indexed: payload.indexed, total: payload.total, percent: payload.percent },
        });
      },

      /** Handle embedding:complete push event */
      onEmbeddingComplete(): void {
        const progress = store.indexProgress();
        patchState(store, {
          indexStatus: 'complete',
          indexProgress: progress
            ? { ...progress, percent: 100 }
            : null,
          indexError: null,
        });
      },

      /** Handle embedding:error push event */
      onEmbeddingError(payload: EmbeddingErrorPayload): void {
        patchState(store, {
          indexStatus: 'partial',
          indexError: payload.message,
        });
      },

      /** Dismiss the index error banner */
      clearIndexError(): void {
        patchState(store, { indexError: null });
      },
    };
  }),
  withHooks((store) => {
    const electronService = inject(ElectronService);
    const toastService = inject(ToastService);

    return {
      onInit(): void {
        /* c8 ignore next -- non-Electron environment */
        if (!electronService.isElectron) {
          return;
        }

        electronService.onEvent<EmbeddingProgressPayload>('embedding:progress').subscribe((payload) => {
          store.onEmbeddingProgress(payload);
        });

        electronService.onEvent<void>('embedding:complete').subscribe(() => {
          store.onEmbeddingComplete();
        });

        electronService.onEvent<EmbeddingErrorPayload>('embedding:error').subscribe((payload) => {
          store.onEmbeddingError(payload);
        });

        electronService.onEvent<void>('embedding:resume').subscribe(() => {
          // Show informational toast so the user knows indexing is resuming
          toastService.info('Resuming index build...');
          // Patch state so the UI immediately reflects that a build is starting
          patchState(store, { indexStatus: 'building' });
        });

        // Subscribe to streaming semantic search push events
        electronService.onAiSearchBatch().subscribe((payload) => {
          void store.onSearchBatch(payload).catch(
            /* c8 ignore next -- async rejection log, unreachable in normal flow */
            (batchError: unknown) => {
            console.warn('[AiStore] Unhandled error in onSearchBatch:', batchError);
            }
          );
        });

        electronService.onAiSearchComplete().subscribe((payload) => {
          store.onSearchComplete(payload);
        });
      },
    };
  })
);
