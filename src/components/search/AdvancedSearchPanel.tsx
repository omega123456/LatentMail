import { useMemo, useState } from 'react';
import { format, fromUnixTime } from 'date-fns';
import type { MailLabel, ParsedSearchQuery, SearchPredicate, SearchScope } from '@/lib/types/ipc';
import { useParseSearchQueryQuery } from '@/lib/query/hooks';
import { Select, type SelectOption } from '@/components/shared/Select';
import {
  BLANK_DATE_FILTER,
  DateFilter,
  dateFilterFromPredicates,
  serializeDateFilter,
  type DateFilterValue,
} from './DateFilter';

type PanelFields = {
  from: string;
  to: string;
  subject: string;
  includesText: string;
  excludesText: string;
  date: DateFilterValue;
  hasAttachment: boolean;
  unreadOnly: boolean;
};

const BLANK_FIELDS: PanelFields = {
  from: '',
  to: '',
  subject: '',
  includesText: '',
  excludesText: '',
  date: BLANK_DATE_FILTER,
  hasAttachment: false,
  unreadOnly: false,
};

export function quoteIfNeeded(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value;
}

export function predicateToToken(predicate: SearchPredicate): string | null {
  const prefix = predicate.negated ? '-' : '';
  switch (predicate.kind) {
    case 'label':
      return `${prefix}label:${quoteIfNeeded(predicate.value)}`;
    case 'starred':
      return `${prefix}is:starred`;
    case 'hasAttachment':
      return `${prefix}has:attachment`;
    case 'unread':
      return `${prefix}is:unread`;
    case 'sentBefore':
      return `${prefix}before:${format(fromUnixTime(predicate.atSeconds), 'yyyy-MM-dd')}`;
    case 'sentAfter':
      return `${prefix}after:${format(fromUnixTime(predicate.atSeconds), 'yyyy-MM-dd')}`;
    case 'textExcludes':
      return null;
  }
}

export function fieldsFromParsedQuery(parsed: ParsedSearchQuery): PanelFields {
  const { value: date, remaining } = dateFilterFromPredicates(parsed.predicates);
  let hasAttachment = false;
  let unreadOnly = false;
  const leftover: string[] = [];
  for (const predicate of remaining) {
    if (predicate.kind === 'hasAttachment' && !predicate.negated) hasAttachment = true;
    else if (predicate.kind === 'unread' && !predicate.negated) unreadOnly = true;
    else {
      const token = predicateToToken(predicate);
      if (token) leftover.push(token);
    }
  }
  return {
    from: parsed.from ?? '',
    to: parsed.to ?? '',
    subject: parsed.subject ?? '',
    includesText: [...parsed.includes, ...leftover].join(' '),
    excludesText: parsed.excludes.join(' '),
    date,
    hasAttachment,
    unreadOnly,
  };
}

export function serializeFields(fields: PanelFields): string {
  const parts: string[] = [];
  if (fields.from.trim()) parts.push(`from:${quoteIfNeeded(fields.from.trim())}`);
  if (fields.to.trim()) parts.push(`to:${quoteIfNeeded(fields.to.trim())}`);
  if (fields.subject.trim()) parts.push(`subject:${quoteIfNeeded(fields.subject.trim())}`);
  if (fields.includesText.trim()) parts.push(fields.includesText.trim());
  if (fields.excludesText.trim())
    parts.push(
      ...fields.excludesText
        .trim()
        .split(/\s+/)
        .map((word) => (word.startsWith('-') ? word : `-${word}`)),
    );
  parts.push(...serializeDateFilter(fields.date));
  if (fields.hasAttachment) parts.push('has:attachment');
  if (fields.unreadOnly) parts.push('is:unread');
  return parts.join(' ');
}

const inputClass =
  'select-text rounded border border-outline-variant/50 bg-surface-container-lowest px-2 py-1.5 text-body-sm text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest dark:text-dark-on-surface';
const selectClass = `${inputClass} cursor-pointer`;
const labelClass = 'text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant';
const selectWrapperClass = 'flex flex-col gap-1';

function scopeOptions(userLabels: MailLabel[]): SelectOption<string>[] {
  return [
    { value: JSON.stringify({ kind: 'default' }), label: 'All mail' },
    { value: JSON.stringify({ kind: 'label', labelId: 'INBOX' }), label: 'Inbox' },
    { value: JSON.stringify({ kind: 'label', labelId: 'SENT' }), label: 'Sent' },
    ...userLabels.map((label) => ({
      value: JSON.stringify({ kind: 'label', labelId: label.id }),
      label: label.name,
    })),
    { value: JSON.stringify({ kind: 'all' }), label: 'Mail, Spam and Trash' },
  ];
}

export function AdvancedSearchPanel({
  initialQuery,
  labels,
  scope,
  onScopeChange,
  onSubmit,
  onClose,
}: {
  initialQuery: string;
  labels: MailLabel[];
  scope: SearchScope;
  onScopeChange: (scope: SearchScope) => void;
  onSubmit: (query: string) => void;
  onClose: () => void;
}) {
  const parsedQuery = useParseSearchQueryQuery(initialQuery);
  const baseFields = useMemo<PanelFields>(
    () =>
      initialQuery.trim() && parsedQuery.data
        ? fieldsFromParsedQuery(parsedQuery.data)
        : BLANK_FIELDS,
    [initialQuery, parsedQuery.data],
  );
  const [overrides, setOverrides] = useState<PanelFields | null>(null);
  const fields = overrides ?? baseFields;
  const setFields = (updater: (current: PanelFields) => PanelFields) =>
    setOverrides((current) => updater(current ?? baseFields));

  const userLabels = labels.filter((label) => label.kind === 'user');
  const scopeValue = JSON.stringify(scope);

  return (
    <>
      <div
        aria-hidden="true"
        data-testid="advanced-search-panel-overlay"
        className="fixed inset-0 z-40 bg-on-surface/20"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-label="Advanced search"
        data-testid="advanced-search-panel"
        className="absolute left-0 right-0 top-full z-50 mt-2 flex flex-col gap-3 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-4 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
      >
        <label htmlFor="search-panel-from" className="flex flex-col gap-1">
          <span className={labelClass}>From</span>
          <input
            id="search-panel-from"
            type="text"
            value={fields.from}
            onChange={(event) => setFields((current) => ({ ...current, from: event.target.value }))}
            className={inputClass}
          />
        </label>
        <label htmlFor="search-panel-to" className="flex flex-col gap-1">
          <span className={labelClass}>To</span>
          <input
            id="search-panel-to"
            type="text"
            value={fields.to}
            onChange={(event) => setFields((current) => ({ ...current, to: event.target.value }))}
            className={inputClass}
          />
        </label>
        <label htmlFor="search-panel-subject" className="flex flex-col gap-1">
          <span className={labelClass}>Subject</span>
          <input
            id="search-panel-subject"
            type="text"
            value={fields.subject}
            onChange={(event) =>
              setFields((current) => ({ ...current, subject: event.target.value }))
            }
            className={inputClass}
          />
        </label>
        <label htmlFor="search-panel-includes" className="flex flex-col gap-1">
          <span className={labelClass}>Includes the words</span>
          <input
            id="search-panel-includes"
            type="text"
            value={fields.includesText}
            onChange={(event) =>
              setFields((current) => ({ ...current, includesText: event.target.value }))
            }
            className={inputClass}
          />
        </label>
        <label htmlFor="search-panel-excludes" className="flex flex-col gap-1">
          <span className={labelClass}>Doesn&rsquo;t have</span>
          <input
            id="search-panel-excludes"
            type="text"
            value={fields.excludesText}
            onChange={(event) =>
              setFields((current) => ({ ...current, excludesText: event.target.value }))
            }
            className={inputClass}
          />
        </label>
        <DateFilter
          value={fields.date}
          onChange={(date) => setFields((current) => ({ ...current, date }))}
        />
        <div className={selectWrapperClass}>
          <label htmlFor="search-panel-scope" className={labelClass}>
            Search in
          </label>
          <Select
            id="search-panel-scope"
            value={scopeValue}
            onChange={(next) => onScopeChange(JSON.parse(next) as SearchScope)}
            options={scopeOptions(userLabels)}
            className={selectClass}
          />
        </div>
        <div className="flex items-center gap-4">
          <label className="flex items-center gap-2 text-body-sm text-on-surface dark:text-dark-on-surface">
            <input
              type="checkbox"
              checked={fields.hasAttachment}
              onChange={(event) =>
                setFields((current) => ({ ...current, hasAttachment: event.target.checked }))
              }
              className="size-4"
            />
            Has attachment
          </label>
          <label className="flex items-center gap-2 text-body-sm text-on-surface dark:text-dark-on-surface">
            <input
              type="checkbox"
              checked={fields.unreadOnly}
              onChange={(event) =>
                setFields((current) => ({ ...current, unreadOnly: event.target.checked }))
              }
              className="size-4"
            />
            Unread only
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-outline-variant/40 pt-3 dark:border-dark-outline-variant">
          <button
            type="button"
            onClick={() => setOverrides(BLANK_FIELDS)}
            className="cursor-pointer rounded px-3 py-1.5 text-label-md text-secondary hover:bg-surface-container-low focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-secondary dark:hover:bg-dark-surface-container"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={() => {
              const serialized = serializeFields(fields);
              if (serialized.trim().length === 0) return;
              onSubmit(serialized);
            }}
            className="cursor-pointer rounded bg-primary px-3 py-1.5 text-label-md text-on-primary focus-visible:outline-2 focus-visible:outline-primary dark:bg-dark-primary dark:text-dark-on-primary"
          >
            Search
          </button>
        </div>
      </div>
    </>
  );
}
