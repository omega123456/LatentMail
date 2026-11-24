import { addDays, format, fromUnixTime, parseISO } from 'date-fns';
import type { MailLabel, ParsedSearchQuery, SearchPredicate } from '@/lib/types/ipc';
import { DATE_FORMAT } from '@/lib/format/date-formats';

export type DateFilterMode = 'preset' | 'before' | 'after' | 'on' | 'between';

export type DateFilterValue = {
  mode: DateFilterMode;
  preset: string;
  start: string;
  end: string;
};

export const BLANK_DATE_FILTER: DateFilterValue = {
  mode: 'preset',
  preset: '',
  start: '',
  end: '',
};

export const PRESETS: { value: string; label: string; summary: string }[] = [
  { value: '', label: 'Any time', summary: 'Any time' },
  { value: '1d', label: '1 day', summary: 'Last 24 hours' },
  { value: '7d', label: '1 week', summary: 'Last 7 days' },
  { value: '14d', label: '2 weeks', summary: 'Last 14 days' },
  { value: '1m', label: '1 month', summary: 'Last 30 days' },
  { value: '3m', label: '3 months', summary: 'Last 3 months' },
  { value: '6m', label: '6 months', summary: 'Last 6 months' },
  { value: '1y', label: '1 year', summary: 'Last year' },
];

export type PanelFields = {
  from: string;
  to: string;
  subject: string;
  includesText: string;
  excludesText: string;
  date: DateFilterValue;
  hasAttachment: boolean;
  unreadOnly: boolean;
};

export const BLANK_FIELDS: PanelFields = {
  from: '',
  to: '',
  subject: '',
  includesText: '',
  excludesText: '',
  date: BLANK_DATE_FILTER,
  hasAttachment: false,
  unreadOnly: false,
};

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

function toIsoDay(atSeconds: number): string {
  return format(fromUnixTime(atSeconds), DATE_FORMAT.isoDate);
}

function shiftIsoDay(iso: string, days: number): string {
  return format(addDays(parseISO(iso), days), DATE_FORMAT.isoDate);
}

export function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function serializeDateFilter(value: DateFilterValue): string[] {
  if (value.mode === 'preset') return value.preset ? [`newer_than:${value.preset}`] : [];
  if (!value.start) return [];
  if (value.mode === 'before') return [`before:${value.start}`];
  if (value.mode === 'after') return [`after:${value.start}`];
  if (value.mode === 'on') return [`after:${value.start}`, `before:${shiftIsoDay(value.start, 1)}`];
  return value.end
    ? [`after:${value.start}`, `before:${shiftIsoDay(value.end, 1)}`]
    : [`after:${value.start}`];
}

function buildDateFilterValue(after: string | null, before: string | null): DateFilterValue {
  if (after !== null && before !== null) {
    const end = shiftIsoDay(before, -1);
    return { mode: after === end ? 'on' : 'between', preset: '', start: after, end: end };
  }
  if (after !== null) return { ...BLANK_DATE_FILTER, mode: 'after', start: after };
  if (before !== null) return { ...BLANK_DATE_FILTER, mode: 'before', start: before };
  return BLANK_DATE_FILTER;
}

export function dateFilterFromPredicates(predicates: SearchPredicate[]): {
  value: DateFilterValue;
  remaining: SearchPredicate[];
} {
  const remaining: SearchPredicate[] = [];
  let after: string | null = null;
  let before: string | null = null;
  for (const predicate of predicates) {
    if (predicate.kind === 'sentAfter' && !predicate.negated && after === null) {
      after = toIsoDay(predicate.atSeconds);
      continue;
    }
    if (predicate.kind === 'sentBefore' && !predicate.negated && before === null) {
      before = toIsoDay(predicate.atSeconds);
      continue;
    }
    remaining.push(predicate);
  }
  return { value: buildDateFilterValue(after, before), remaining: remaining };
}

export function summariseDateFilter(value: DateFilterValue): string {
  if (value.mode === 'preset')
    return PRESETS.find((preset) => preset.value === value.preset)?.summary ?? 'Any time';
  if (!value.start) return 'Pick a date';
  const readable = (iso: string) => format(parseISO(iso), DATE_FORMAT.dayMonthYear);
  if (value.mode === 'before') return `Before ${readable(value.start)}`;
  if (value.mode === 'after') return `After ${readable(value.start)}`;
  if (value.mode === 'on') return `On ${readable(value.start)}`;
  return value.end
    ? `${readable(value.start)} – ${readable(value.end)}`
    : `From ${readable(value.start)}`;
}

export function predicateToToken(predicate: SearchPredicate): string | null {
  const prefix = predicate.negated ? '-' : '';
  if (predicate.kind === 'label') return `${prefix}label:${quoteIfNeeded(predicate.value)}`;
  if (predicate.kind === 'starred') return `${prefix}is:starred`;
  if (predicate.kind === 'hasAttachment') return `${prefix}has:attachment`;
  if (predicate.kind === 'unread') return `${prefix}is:unread`;
  if (predicate.kind === 'sentBefore') return `${prefix}before:${toIsoDay(predicate.atSeconds)}`;
  if (predicate.kind === 'sentAfter') return `${prefix}after:${toIsoDay(predicate.atSeconds)}`;
  return null;
}

export function fieldsFromParsedQuery(parsed: ParsedSearchQuery): PanelFields {
  const { value: date, remaining } = dateFilterFromPredicates(parsed.predicates);
  let hasAttachment = false;
  let unreadOnly = false;
  const leftover: string[] = [];
  for (const predicate of remaining) {
    if (predicate.kind === 'hasAttachment' && !predicate.negated) {
      hasAttachment = true;
      continue;
    }
    if (predicate.kind === 'unread' && !predicate.negated) {
      unreadOnly = true;
      continue;
    }
    const token = predicateToToken(predicate);
    if (token) leftover.push(token);
  }
  return {
    from: parsed.from ?? '',
    to: parsed.to ?? '',
    subject: parsed.subject ?? '',
    includesText: [...parsed.includes, ...leftover].join(' '),
    excludesText: parsed.excludes.join(' '),
    date: date,
    hasAttachment: hasAttachment,
    unreadOnly: unreadOnly,
  };
}

export function serializeFields(fields: PanelFields): string {
  const parts: string[] = [];
  if (fields.from.trim()) parts.push(`from:${quoteIfNeeded(fields.from.trim())}`);
  if (fields.to.trim()) parts.push(`to:${quoteIfNeeded(fields.to.trim())}`);
  if (fields.subject.trim()) parts.push(`subject:${quoteIfNeeded(fields.subject.trim())}`);
  if (fields.includesText.trim()) parts.push(fields.includesText.trim());
  if (fields.excludesText.trim()) {
    parts.push(
      ...fields.excludesText
        .trim()
        .split(/\s+/)
        .map((word) => (word.startsWith('-') ? word : `-${word}`)),
    );
  }
  parts.push(...serializeDateFilter(fields.date));
  if (fields.hasAttachment) parts.push('has:attachment');
  if (fields.unreadOnly) parts.push('is:unread');
  return parts.join(' ');
}

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
  const operand = token.slice(colonIndex + 1);

  if (key === 'label' || key === 'in') {
    return labels
      .filter((label) => label.name.toLowerCase().startsWith(operand.toLowerCase()))
      .map((label) => ({
        insert: `${prefix}${key}:${quoteIfNeeded(label.id)}`,
        primary: label.name,
        secondary: label.id,
      }));
  }

  const values = VALUES[key];
  if (!values) return [];
  return values
    .filter((candidate) => candidate.toLowerCase().startsWith(operand.toLowerCase()))
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
