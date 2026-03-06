export interface AiModel {
  name: string;
  size?: number;
  modifiedAt?: string;
  digest?: string;
}

export interface AiStatus {
  connected: boolean;
  url: string;
  currentModel?: string;
  availableModels?: AiModel[];
}

export interface AiSummary {
  threadId: string;
  summary: string;
  keyPoints: string[];
  createdAt: string;
}

export interface AiReplySuggestion {
  text: string;
  tone: 'professional' | 'casual' | 'grateful' | 'concerned';
}

export type TextTransformation = 'improve' | 'shorten' | 'formalize' | 'casualize';

export interface AiComposeRequest {
  prompt: string;
  context?: string;
  tone?: 'professional' | 'casual' | 'formal';
}

export interface AiStreamEvent {
  type: 'summarize' | 'compose' | 'transform';
  token: string;
  done: boolean;
  requestId?: string;
}

export interface SearchIntentDateRange {
  after?: string;
  before?: string;
  relative?: string;
}

export interface SearchIntentFlags {
  unread?: boolean;
  starred?: boolean;
  important?: boolean;
  hasAttachment?: boolean;
}

export interface SearchIntent {
  keywords: string[];
  synonyms: string[];
  direction: 'sent' | 'received' | 'any';
  folder: string | null;
  sender: string | null;
  recipient: string | null;
  dateRange: SearchIntentDateRange | null;
  flags: SearchIntentFlags;
  exactPhrases: string[];
  negations: string[];
}

/** @deprecated Use SearchIntent and generated queries instead. */
export interface AiSearchResult {
  query: string;
}

export interface AiFilterSuggestion {
  name: string;
  conditions: Array<{ field: string; operator: string; value: string }>;
  actions: Array<{ type: string; value?: string }>;
}

export interface AiFollowUpResult {
  needsFollowUp: boolean;
  reason: string;
  suggestedDate?: string;
}

export interface SourceEmail {
  xGmMsgId: string;
  fromName: string;
  fromAddress: string;
  subject: string;
  date: string;  // ISO date string
  citationIndex: number;  // The [N] number used to cite this email in the response
}

export interface ChatMessage {
  id: string;              // Unique message ID
  role: 'user' | 'assistant';
  content: string;         // Message text (progressively built for streaming)
  sources: SourceEmail[];  // Empty for user messages, populated for AI messages
  timestamp: Date;
  streaming: boolean;      // True while tokens are still arriving
  error: string | null;    // Error message if generation failed
}

export interface ChatStreamPayload {
  requestId: string;
  token: string;
}

export interface ChatSourcesPayload {
  requestId: string;
  sources: SourceEmail[];
}

export interface ChatDonePayload {
  requestId: string;
  success: boolean;
  cancelled?: boolean;
  error?: string;
}
