import { useMemo, useState } from 'react';
import type { MailLabel, SearchScope } from '@/lib/types/ipc';
import { useParseSearchQueryQuery } from '@/lib/query/hooks';
import { Select, type SelectOption } from '@/components/shared/Select';
import { TextInput } from '@/components/shared/TextInput';
import { DateFilter } from './DateFilter';
import {
  BLANK_FIELDS,
  fieldsFromParsedQuery,
  predicateToToken,
  quoteIfNeeded,
  serializeFields,
  type PanelFields,
} from '@/lib/search/grammar';
import { primaryActionButtonClass, secondaryActionButtonClass } from '@/components/shared/styles';

export { fieldsFromParsedQuery, predicateToToken, quoteIfNeeded, serializeFields };

const selectClass =
  'select-text cursor-pointer rounded border border-outline-variant/50 bg-surface-container-lowest px-2 py-1.5 text-body-sm text-on-surface focus-visible:outline-2 focus-visible:outline-primary dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest dark:text-dark-on-surface';
const labelClass = 'text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant';
const selectWrapperClass = 'flex flex-col gap-1';

type ScopeChoice = { scope: SearchScope; label: string };
type TextFieldKey = 'from' | 'to' | 'subject' | 'includesText' | 'excludesText';

const TEXT_FIELDS: { key: TextFieldKey; id: string; label: string }[] = [
  { key: 'from', id: 'search-panel-from', label: 'From' },
  { key: 'to', id: 'search-panel-to', label: 'To' },
  { key: 'subject', id: 'search-panel-subject', label: 'Subject' },
  { key: 'includesText', id: 'search-panel-includes', label: 'Includes the words' },
  { key: 'excludesText', id: 'search-panel-excludes', label: 'Doesn\u2019t have' },
];

function scopeKey(scope: SearchScope): string {
  return JSON.stringify(scope);
}

function scopeChoices(userLabels: MailLabel[]): ScopeChoice[] {
  return [
    { scope: { kind: 'default' }, label: 'All mail' },
    { scope: { kind: 'label', labelId: 'INBOX' }, label: 'Inbox' },
    { scope: { kind: 'label', labelId: 'SENT' }, label: 'Sent' },
    ...userLabels.map((label): ScopeChoice => ({
      scope: { kind: 'label', labelId: label.id },
      label: label.name,
    })),
    { scope: { kind: 'all' }, label: 'Mail, Spam and Trash' },
  ];
}

function scopeOptions(choices: ScopeChoice[]): SelectOption<string>[] {
  return choices.map((choice) => ({ value: scopeKey(choice.scope), label: choice.label }));
}

function scopeForKey(choices: ScopeChoice[], key: string): SearchScope | undefined {
  return choices.find((choice) => scopeKey(choice.scope) === key)?.scope;
}

function usePanelFields(initialQuery: string) {
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
  const resetFields = () => setOverrides(BLANK_FIELDS);
  return { fields: fields, setFields: setFields, resetFields: resetFields };
}

function SearchPanelFlags({
  fields,
  onChange,
}: {
  fields: PanelFields;
  onChange: (updater: (current: PanelFields) => PanelFields) => void;
}) {
  return (
    <div className="flex items-center gap-4">
      <label className="flex items-center gap-2 text-body-sm text-on-surface dark:text-dark-on-surface">
        <input
          type="checkbox"
          checked={fields.hasAttachment}
          onChange={(event) =>
            onChange((current) => ({ ...current, hasAttachment: event.target.checked }))
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
            onChange((current) => ({ ...current, unreadOnly: event.target.checked }))
          }
          className="size-4"
        />
        Unread only
      </label>
    </div>
  );
}

function SearchPanelActions({ onReset, onSearch }: { onReset: () => void; onSearch: () => void }) {
  return (
    <div className="flex justify-end gap-2 border-t border-outline-variant/40 pt-3 dark:border-dark-outline-variant">
      <button type="button" onClick={onReset} className={secondaryActionButtonClass}>
        Reset
      </button>
      <button type="button" onClick={onSearch} className={primaryActionButtonClass}>
        Search
      </button>
    </div>
  );
}

type AdvancedSearchPanelProps = {
  initialQuery: string;
  labels: MailLabel[];
  scope: SearchScope;
  onScopeChange: (scope: SearchScope) => void;
  onSubmit: (query: string) => void;
  onClose: () => void;
};

function ScopeField({
  scope,
  choices,
  onSelectScope,
}: {
  scope: SearchScope;
  choices: ScopeChoice[];
  onSelectScope: (key: string) => void;
}) {
  return (
    <div className={selectWrapperClass}>
      <label htmlFor="search-panel-scope" className={labelClass}>
        Search in
      </label>
      <Select
        id="search-panel-scope"
        value={scopeKey(scope)}
        onChange={onSelectScope}
        options={scopeOptions(choices)}
        className={selectClass}
      />
    </div>
  );
}

export function AdvancedSearchPanel(props: AdvancedSearchPanelProps) {
  const { fields, setFields, resetFields } = usePanelFields(props.initialQuery);
  const choices = scopeChoices(props.labels.filter((label) => label.kind === 'user'));
  const selectScope = (key: string) => {
    const chosen = scopeForKey(choices, key);
    if (chosen) props.onScopeChange(chosen);
  };
  const submitSearch = () => {
    const serialized = serializeFields(fields);
    if (serialized.trim().length === 0) return;
    props.onSubmit(serialized);
  };

  return (
    <>
      <div
        aria-hidden="true"
        data-testid="advanced-search-panel-overlay"
        className="fixed inset-0 z-40 bg-on-surface/20"
        onClick={props.onClose}
      />
      <div
        role="dialog"
        aria-label="Advanced search"
        data-testid="advanced-search-panel"
        className="absolute left-0 right-0 top-full z-50 mt-2 flex flex-col gap-3 rounded-md border border-outline-variant/40 bg-surface-container-lowest p-4 shadow-sm dark:border-dark-outline-variant dark:bg-dark-surface-container-lowest"
      >
        {TEXT_FIELDS.map((entry) => (
          <label key={entry.key} htmlFor={entry.id} className="flex flex-col gap-1">
            <span className={labelClass}>{entry.label}</span>
            <TextInput
              id={entry.id}
              value={fields[entry.key]}
              onChange={(event) =>
                setFields((current) => ({ ...current, [entry.key]: event.target.value }))
              }
            />
          </label>
        ))}
        <DateFilter
          value={fields.date}
          onChange={(date) => setFields((current) => ({ ...current, date }))}
        />
        <ScopeField scope={props.scope} choices={choices} onSelectScope={selectScope} />
        <SearchPanelFlags fields={fields} onChange={setFields} />
        <SearchPanelActions onReset={resetFields} onSearch={submitSearch} />
      </div>
    </>
  );
}
