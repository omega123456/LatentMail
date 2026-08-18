import type { MailLabel } from '@/lib/types/ipc';
import { quoteIfNeeded } from './AdvancedSearchPanel';
import { PRESETS } from './DateFilter';

export type SearchSuggestion = { insert: string; primary: string; secondary?: string };

const KEYWORDS: { key: string; secondary: string }[] = [
  { key: 'from', secondary: 'Sender' },
  { key: 'to', secondary: 'Recipient' },
  { key: 'subject', secondary: 'Subject text' },
  { key: 'label', secondary: 'Label' },
  { key: 'in', secondary: 'Label' },
  { key: 'is', secondary: 'unread, read, starred, unstarred' },
  { key: 'has', secondary: 'attachment' },
  { key: 'before', secondary: 'yyyy-mm-dd' },
  { key: 'after', secondary: 'yyyy-mm-dd' },
  { key: 'newer_than', secondary: '7d, 1m, 1y' },
  { key: 'older_than', secondary: '7d, 1m, 1y' },
];

const DURATION_VALUES = PRESETS.filter((preset) => preset.value !== '').map(
  (preset) => preset.value,
);

const VALUES: Record<string, string[]> = {
  is: ['unread', 'read', 'starred', 'unstarred'],
  has: ['attachment'],
  newer_than: DURATION_VALUES,
  older_than: DURATION_VALUES,
};

function splitTrailingToken(draft: string): string {
  return draft.slice(draft.lastIndexOf(' ') + 1);
}

export function suggestionsFor(draft: string, labels: MailLabel[]): SearchSuggestion[] {
  const rawToken = splitTrailingToken(draft);
  const negated = rawToken.startsWith('-');
  const token = negated ? rawToken.slice(1) : rawToken;
  const prefix = negated ? '-' : '';
  if (token.length === 0) return [];

  const colonIndex = token.indexOf(':');
  if (colonIndex === -1) {
    return KEYWORDS.filter((keyword) =>
      keyword.key.toLowerCase().startsWith(token.toLowerCase()),
    ).map((keyword) => ({
      insert: `${prefix}${keyword.key}:`,
      primary: `${keyword.key}:`,
      secondary: keyword.secondary,
    }));
  }

  const key = token.slice(0, colonIndex).toLowerCase();
  const value = token.slice(colonIndex + 1);

  if (key === 'label' || key === 'in') {
    return labels
      .filter((label) => label.name.toLowerCase().startsWith(value.toLowerCase()))
      .map((label) => ({
        insert: `${prefix}${key}:${quoteIfNeeded(label.id)}`,
        primary: label.name,
        secondary: label.id,
      }));
  }

  const values = VALUES[key];
  if (!values) return [];
  return values
    .filter((candidate) => candidate.toLowerCase().startsWith(value.toLowerCase()))
    .map((candidate) => ({
      insert: `${prefix}${key}:${candidate}`,
      primary: `${key}:${candidate}`,
    }));
}

export function applySuggestion(draft: string, insert: string): string {
  const head = draft.slice(0, draft.lastIndexOf(' ') + 1);
  const trailingSpace = insert.endsWith(':') ? '' : ' ';
  return `${head}${insert}${trailingSpace}`;
}
