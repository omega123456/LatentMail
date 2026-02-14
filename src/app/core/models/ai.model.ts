export interface AiModel {
  name: string;
  size?: number;
  modifiedAt?: string;
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
