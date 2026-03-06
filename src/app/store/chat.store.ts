import { computed, effect, inject } from '@angular/core';
import { signalStore, withState, withComputed, withMethods, patchState, withHooks } from '@ngrx/signals';
import { ElectronService } from '../core/services/electron.service';
import { AccountsStore } from './accounts.store';
import { AiStore } from './ai.store';
import { ChatMessage, ChatStreamPayload, ChatSourcesPayload, ChatDonePayload } from '../core/models/ai.model';

interface ChatState {
  messages: ChatMessage[];
  streamingMessageId: string | null;
  streamRequestId: string | null;
  inputDisabled: boolean;
  /**
   * Unique identifier for the current chat session. A new UUID is generated each time
   * newChat() is called, allowing sendMessage() to detect if the session was reset
   * before the aiChat() IPC call resolved and discard the stale response.
   */
  chatSessionId: string;
}

const initialState: ChatState = {
  messages: [],
  streamingMessageId: null,
  streamRequestId: null,
  inputDisabled: false,
  chatSessionId: crypto.randomUUID(),
};

export const ChatStore = signalStore(
  { providedIn: 'root' },
  withState(initialState),
  withComputed((store) => {
    const aiStore = inject(AiStore);

    return {
      panelStatus: computed((): 'disabled' | 'ready' => {
        const connected = aiStore.connected();
        const currentModel = aiStore.currentModel();
        const indexStatus = aiStore.indexStatus();
        const hasEmbeddings = indexStatus === 'complete' || indexStatus === 'partial';
        if (!connected || !currentModel || !hasEmbeddings) {
          return 'disabled';
        }
        return 'ready';
      }),
    };
  }),
  withMethods((store) => {
    const electronService = inject(ElectronService);

    return {
      /** Add a user message and an AI placeholder, invoke the chat IPC, and begin streaming. */
      async sendMessage(question: string, accountId: number): Promise<void> {
        const userMessageId = crypto.randomUUID();
        const aiMessageId = crypto.randomUUID();

        // Capture the current session ID before the async IPC call. If the user
        // starts a new chat while aiChat() is in flight, the session ID will have
        // changed and we discard the stale response.
        const sessionId = store.chatSessionId();

        const userMessage: ChatMessage = {
          id: userMessageId,
          role: 'user',
          content: question,
          sources: [],
          timestamp: new Date(),
          streaming: false,
          error: null,
        };

        const aiPlaceholder: ChatMessage = {
          id: aiMessageId,
          role: 'assistant',
          content: '',
          sources: [],
          timestamp: new Date(),
          streaming: true,
          error: null,
        };

        // Build conversation history from existing messages (excluding the new user message)
        const conversationHistory = store.messages().map((message) => ({
          role: message.role,
          content: message.content,
        }));

        patchState(store, {
          messages: [...store.messages(), userMessage, aiPlaceholder],
          streamingMessageId: aiMessageId,
          inputDisabled: true,
        });

        const response = await electronService.aiChat(question, conversationHistory, accountId);

        // Guard: if the session was reset (newChat() called) while the IPC was in
        // flight, discard this response entirely — the stale placeholder no longer
        // exists in the message list.
        if (store.chatSessionId() !== sessionId) {
          return;
        }

        if (response.success && response.data) {
          patchState(store, { streamRequestId: response.data.requestId });
        } else {
          // IPC call itself failed — mark the AI placeholder as errored and re-enable input
          const errorMessage = response.error?.message ?? 'Failed to start chat';
          patchState(store, {
            messages: store.messages().map((message) => {
              if (message.id === aiMessageId) {
                return { ...message, streaming: false, error: errorMessage };
              }
              return message;
            }),
            streamingMessageId: null,
            streamRequestId: null,
            inputDisabled: false,
          });
        }
      },

      /** Append a streamed token to the current streaming message (if requestId matches). */
      appendStreamToken(payload: ChatStreamPayload): void {
        const currentRequestId = store.streamRequestId();
        if (currentRequestId === null || payload.requestId !== currentRequestId) {
          return;
        }
        const streamingId = store.streamingMessageId();
        if (streamingId === null) {
          return;
        }
        patchState(store, {
          messages: store.messages().map((message) => {
            if (message.id === streamingId) {
              return { ...message, content: message.content + payload.token };
            }
            return message;
          }),
        });
      },

      /** Attach source emails to the current streaming AI message (if requestId matches). */
      attachSources(payload: ChatSourcesPayload): void {
        const currentRequestId = store.streamRequestId();
        if (currentRequestId === null || payload.requestId !== currentRequestId) {
          return;
        }
        const streamingId = store.streamingMessageId();
        if (streamingId === null) {
          return;
        }
        patchState(store, {
          messages: store.messages().map((message) => {
            if (message.id === streamingId) {
              return { ...message, sources: payload.sources };
            }
            return message;
          }),
        });
      },

      /** Handle the chat-done event: mark streaming complete and reset streaming state. */
      onChatDone(payload: ChatDonePayload): void {
        const currentRequestId = store.streamRequestId();
        if (currentRequestId === null || payload.requestId !== currentRequestId) {
          return;
        }
        const streamingId = store.streamingMessageId();
        patchState(store, {
          messages: store.messages().map((message) => {
            if (message.id === streamingId) {
              if (payload.cancelled) {
                // Keep partial content but mark as no longer streaming
                return { ...message, streaming: false, error: null };
              }
              if (!payload.success && payload.error) {
                return { ...message, streaming: false, error: payload.error };
              }
              return { ...message, streaming: false, error: null };
            }
            return message;
          }),
          streamingMessageId: null,
          streamRequestId: null,
          inputDisabled: false,
        });
      },

      /** Clear all messages and reset streaming state (e.g. on account switch or new chat). */
      async newChat(): Promise<void> {
        // Cancel any active stream before clearing state so the in-flight request
        // is aborted and we don't receive stale tokens after the reset.
        const requestId = store.streamRequestId();
        if (requestId !== null) {
          await electronService.aiChatCancel(requestId);
        }
        patchState(store, {
          messages: [],
          streamingMessageId: null,
          streamRequestId: null,
          inputDisabled: false,
          // Generate a new session ID so any in-flight sendMessage() call that
          // hasn't resolved yet will detect the session change and discard its response.
          chatSessionId: crypto.randomUUID(),
        });
      },

      /** Cancel the active streaming request. */
      async cancelStream(): Promise<void> {
        const requestId = store.streamRequestId();
        if (requestId === null) {
          return;
        }
        await electronService.aiChatCancel(requestId);
      },

      /** Update panelStatus externally (e.g. when AI connection state changes). */
      updatePanelStatus(_status: 'disabled' | 'ready'): void {
        // panelStatus is derived via withComputed; this method is a no-op kept for
        // API compatibility. Callers should rely on the computed panelStatus signal.
      },
    };
  }),
  withHooks((store) => {
    const electronService = inject(ElectronService);
    const accountsStore = inject(AccountsStore);

    return {
      onInit(): void {
        // Subscribe to AI chat streaming push events from the main process
        electronService.onAiChatStream$.subscribe((payload) => {
          store.appendStreamToken(payload);
        });

        electronService.onAiChatSources$.subscribe((payload) => {
          store.attachSources(payload);
        });

        electronService.onAiChatDone$.subscribe((payload) => {
          store.onChatDone(payload);
        });

        // Clear conversation when the active account changes
        let previousAccountId = accountsStore.activeAccountId();
        effect(() => {
          const currentAccountId = accountsStore.activeAccountId();
          if (previousAccountId !== currentAccountId) {
            previousAccountId = currentAccountId;
            void store.newChat();
          }
        });
      },
    };
  })
);
