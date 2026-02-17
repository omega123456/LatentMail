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

export interface AiSearchResult {
  structured?: Record<string, unknown>;
  gmraw?: string;
}

export interface AiCategorization {
  category: 'Primary' | 'Updates' | 'Promotions' | 'Social' | 'Newsletters';
}
