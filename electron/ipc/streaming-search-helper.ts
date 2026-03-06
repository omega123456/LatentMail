/**
 * streamingSearchHelper — shared helper for firing streaming search operations
 * in the background and emitting incremental batch/complete push events to the renderer.
 *
 * Extracted from ai-ipc.ts so it can be reused by both the AI_SEARCH handler
 * and the AI_CHAT_NAVIGATE handler.
 */

import { BrowserWindow } from 'electron';
import { LoggerService } from '../services/logger-service';
import { IPC_EVENTS } from './ipc-channels';
import { SearchOptions } from '../services/search-options';

const log = LoggerService.getInstance();

/** Minimal interface for a search service compatible with runStreamingSearch. */
interface SearchService {
  search(options: SearchOptions): Promise<'complete' | 'partial' | 'error'>;
}

/**
 * Fire a streaming search in the background and emit incremental batch/complete
 * push events to the renderer window.
 *
 * - Wraps the service's onBatch callback to emit AI_SEARCH_BATCH events.
 * - Caps total emitted results at maxResults.
 * - Emits AI_SEARCH_COMPLETE when the service's search() promise resolves.
 * - Swallows unexpected throws and emits AI_SEARCH_COMPLETE with status='error'.
 *
 * @param service - The search service to use (keyword, semantic, or message-id).
 * @param win - The BrowserWindow to send push events to.
 * @param options - SearchOptions passed to the service (without onBatch — this function provides it).
 * @param serviceLabel - Label used in log messages (e.g. 'keyword', 'MessageIdSearch').
 * @param searchToken - Unique token for this search session (used to match batch/complete events).
 * @param maxResults - Maximum number of message IDs to emit across all batches.
 */
export async function runStreamingSearch(
  service: SearchService,
  win: BrowserWindow,
  options: SearchOptions,
  serviceLabel: string,
  searchToken: string,
  maxResults: number,
): Promise<void> {
  let emittedCount = 0;

  const optionsWithBatch: SearchOptions = {
    ...options,
    onBatch: (msgIds: string[], phase: 'local' | 'imap') => {
      if (!win || win.isDestroyed()) {
        return;
      }
      if (emittedCount >= maxResults) {
        return;
      }
      const remaining = maxResults - emittedCount;
      const cappedMsgIds = msgIds.slice(0, remaining);
      emittedCount += cappedMsgIds.length;
      win.webContents.send(IPC_EVENTS.AI_SEARCH_BATCH, {
        searchToken,
        msgIds: cappedMsgIds,
        phase,
      });
    },
  };

  try {
    const status = await service.search(optionsWithBatch);
    if (!win || win.isDestroyed()) {
      return;
    }
    log.info(`[AI] search: ${serviceLabel} search finished with status=${status}, totalResults=${emittedCount}`);
    win.webContents.send(IPC_EVENTS.AI_SEARCH_COMPLETE, {
      searchToken,
      status,
      totalResults: emittedCount,
    });
  } catch (searchError) {
    log.warn(`[AI] search: ${serviceLabel} search threw unexpectedly:`, searchError);
    if (!win || win.isDestroyed()) {
      return;
    }
    win.webContents.send(IPC_EVENTS.AI_SEARCH_COMPLETE, {
      searchToken,
      status: 'error',
      totalResults: emittedCount,
    });
  }
}
