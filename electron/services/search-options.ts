/**
 * SearchOptions — unified options object for all BaseSearchService implementations.
 *
 * All fields are optional to support the different search service implementations:
 * - KeywordSearchService and SemanticSearchService use naturalQuery, accountId, userEmail, todayDate, folders, onBatch
 * - MessageIdSearchService uses xGmMsgId, accountId, onBatch
 */

/** Callback type for incremental search result batches. */
export type SearchBatchCallback = (msgIds: string[], phase: 'local' | 'imap') => void;

export interface SearchOptions {
  /** The user's natural language search query (used by keyword and semantic search). */
  naturalQuery?: string;

  /** The account ID to search within. */
  accountId?: number;

  /** The account's email address (for LLM context). */
  userEmail?: string;

  /** Today's date as YYYY-MM-DD (for LLM relative-date resolution). */
  todayDate?: string;

  /** List of folder names for LLM context. */
  folders?: string[];

  /**
   * Callback invoked with each incremental batch of confirmed message IDs.
   * Called at least once with phase 'local' (before any IMAP work begins),
   * then once per IMAP round with phase 'imap'. Batches may be empty.
   */
  onBatch?: SearchBatchCallback;

  /** Gmail message ID for single-message lookup (used by MessageIdSearchService). */
  xGmMsgId?: string;
}
