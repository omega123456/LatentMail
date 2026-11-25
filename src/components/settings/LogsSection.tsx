import { useMemo, useState } from 'react';
import { differenceInCalendarDays, format, isToday, isYesterday } from 'date-fns';
import { RefreshCw } from 'lucide-react';
import { Select } from '@/components/shared/Select';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { settingsQuietButton, settingsTriggerClass } from '@/components/settings/styles';
import {
  HighlightedText,
  SettingsSearchInput,
  SettingsStateText,
} from '@/components/settings/primitives';
import { QueueStateChip } from '@/components/queue/QueueStateChip';
import { useLogEntriesQuery } from '@/lib/query/hooks';
import type { LogEntry } from '@/lib/query/mappers';
import { useLayoutStore } from '@/stores/layout';
import { useToastStore } from '@/stores/toast';
import type { LogLevel } from '@/lib/types/ipc';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { DATE_FORMAT } from '@/lib/format/date-formats';
import { LogPaginationFooter } from './LogPaginationFooter';

const ENTRIES_PER_PAGE = 50;

type LevelFilter = 'all' | LogLevel;

const levelOptions: { value: LogLevel; label: string }[] = [
  { value: 'debug', label: 'Debug' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

const levelFilterOptions: { value: LevelFilter; label: string }[] = [
  { value: 'all', label: 'All levels' },
  ...levelOptions,
];

const pipClass: Record<string, string> = {
  error: 'bg-settings-error dark:bg-dark-settings-error',
  warn: 'bg-settings-amber dark:bg-dark-settings-amber',
  info: 'bg-settings-primary dark:bg-dark-settings-primary',
  debug: 'bg-settings-blocked dark:bg-dark-settings-blocked',
};

const labelClass: Record<string, string> = {
  error: 'text-settings-error dark:text-dark-settings-error',
  warn: 'text-settings-amber dark:text-dark-settings-amber',
  info: 'text-settings-primary dark:text-dark-settings-primary',
  debug: 'text-settings-blocked dark:text-dark-settings-blocked',
};

const stripeClass: Record<string, string> = {
  error: 'border-l-settings-error dark:border-l-dark-settings-error',
  warn: 'border-l-settings-amber dark:border-l-dark-settings-amber',
};

function timeLabel(date: Date) {
  return isToday(date) ? format(date, DATE_FORMAT.logTime) : format(date, DATE_FORMAT.logDateTime);
}

function entryLine(entry: LogEntry) {
  return `${timeLabel(entry.timestamp)} ${entry.level.toUpperCase()} ${entry.message}`;
}

function LogEmptyOrLoadingState({
  isLoading,
  isError,
  totalCount,
  visibleCount,
}: {
  isLoading: boolean;
  isError: boolean;
  totalCount: number | undefined;
  visibleCount: number;
}) {
  if (isLoading) return <SettingsStateText>Loading log entries…</SettingsStateText>;
  if (isError) {
    return (
      <SettingsStateText tone="error" role="alert">
        Couldn&apos;t read the log files.
      </SettingsStateText>
    );
  }
  if (totalCount === 0) return <SettingsStateText>No log entries found.</SettingsStateText>;
  if (totalCount !== undefined && totalCount > 0 && visibleCount === 0) {
    return <SettingsStateText>No entries match your search.</SettingsStateText>;
  }
  return null;
}

function LogEntryRow({
  entry,
  crossedDay,
  needle,
  onCopy,
}: {
  entry: LogEntry;
  crossedDay: boolean;
  needle: string;
  onCopy: (entry: LogEntry) => void;
}) {
  const level = entry.level.toLowerCase();
  return (
    <div>
      {crossedDay && (
        <div className="border-y border-settings-card-line bg-settings-container-low px-4 py-2 font-mono text-settings-meta uppercase tracking-wide text-settings-ink-mute dark:border-dark-settings-card-line dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute">
          {isYesterday(entry.timestamp)
            ? 'Yesterday'
            : format(entry.timestamp, DATE_FORMAT.monthDay)}
        </div>
      )}
      <button
        type="button"
        onClick={() => onCopy(entry)}
        className={`flex w-full cursor-pointer items-start gap-3.5 border-b border-b-settings-card-line border-l-2 px-4 py-2.25 text-left hover:bg-settings-container-low focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-settings-primary dark:border-b-dark-settings-card-line dark:hover:bg-dark-settings-container-low ${
          stripeClass[level] ?? 'border-l-transparent'
        }`}
      >
        <span className="w-29 shrink-0 font-mono text-settings-meta tabular-nums text-settings-ink-mute dark:text-dark-settings-ink-mute">
          {timeLabel(entry.timestamp)}
        </span>
        <QueueStateChip
          pipClassName={pipClass[level] ?? 'bg-settings-ink-mute dark:bg-dark-settings-ink-mute'}
          label={entry.level.toUpperCase()}
          className={`w-20.5 shrink-0 font-mono font-semibold ${
            labelClass[level] ?? 'text-settings-ink-mute dark:text-dark-settings-ink-mute'
          }`}
        />
        <span className="min-w-0 flex-1 break-words whitespace-pre-wrap font-mono text-body-sm text-settings-ink dark:text-dark-settings-ink">
          <HighlightedText text={entry.message} needle={needle} />
        </span>
      </button>
    </div>
  );
}

function LogsHeader({
  logLevel,
  isFetching,
  onLevelChange,
  onRefresh,
}: {
  logLevel: LogLevel;
  isFetching: boolean;
  onLevelChange: (level: LogLevel) => void;
  onRefresh: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-settings-content-max">
      <SettingsSection
        title="Logs"
        description="Reads today's latentmail.log.YYYY-MM-DD, kept for 7 days."
        actions={
          <button
            type="button"
            onClick={onRefresh}
            disabled={isFetching}
            className={settingsQuietButton}
          >
            <RefreshCw aria-hidden="true" size={ICON_SIZE.md} />
            Refresh
          </button>
        }
      >
        <SettingRow
          label="Application log level"
          description="What gets written to the log file, applied immediately."
        >
          <Select
            ariaLabel="Application log level"
            value={logLevel}
            onChange={onLevelChange}
            options={levelOptions}
            className={settingsTriggerClass}
          />
        </SettingRow>
      </SettingsSection>
    </div>
  );
}

function LogTableToolbar({
  search,
  levelFilter,
  onSearchChange,
  onLevelFilterChange,
}: {
  search: string;
  levelFilter: LevelFilter;
  onSearchChange: (next: string) => void;
  onLevelFilterChange: (next: LevelFilter) => void;
}) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2.5 border-b border-settings-card-line p-3.5 dark:border-dark-settings-card-line">
        <SettingsSearchInput
          value={search}
          ariaLabel="Search log entries"
          placeholder="Search"
          onChange={onSearchChange}
          className="min-w-45 flex-1"
        />
        <Select
          ariaLabel="Filter by level"
          value={levelFilter}
          onChange={onLevelFilterChange}
          options={levelFilterOptions}
          className={settingsTriggerClass}
        />
      </div>
      <div className="flex gap-3.5 border-b border-b-settings-card-line px-4 py-2 font-mono text-settings-meta uppercase tracking-wide text-settings-ink-mute dark:border-b-dark-settings-card-line dark:text-dark-settings-ink-mute">
        <span className="w-29 shrink-0">Time</span>
        <span className="w-20.5 shrink-0">Level</span>
        <span className="flex-1">Message</span>
      </div>
    </>
  );
}

function useFilteredLogEntries(
  entries: LogEntry[] | undefined,
  search: string,
  levelFilter: LevelFilter,
) {
  const needle = search.trim().toLowerCase();
  const visible = useMemo(() => {
    if (!entries) return [];
    return entries.filter((entry) => {
      if (levelFilter !== 'all' && entry.level.toLowerCase() !== levelFilter) return false;
      if (!needle) return true;
      return (
        entry.message.toLowerCase().includes(needle) || entry.level.toLowerCase().includes(needle)
      );
    });
  }, [entries, levelFilter, needle]);
  return { needle: needle, visible: visible };
}

function LogEntriesViewport({
  isLoading,
  isError,
  totalCount,
  visibleCount,
  pageEntries,
  needle,
  onCopy,
}: {
  isLoading: boolean;
  isError: boolean;
  totalCount: number | undefined;
  visibleCount: number;
  pageEntries: LogEntry[];
  needle: string;
  onCopy: (entry: LogEntry) => void;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <LogEmptyOrLoadingState
        isLoading={isLoading}
        isError={isError}
        totalCount={totalCount}
        visibleCount={visibleCount}
      />
      {pageEntries.map((entry, index) => {
        const previous = pageEntries[index - 1];
        const crossedDay =
          previous !== undefined &&
          differenceInCalendarDays(previous.timestamp, entry.timestamp) > 0;
        return (
          <LogEntryRow
            key={`${entry.timestamp.getTime()}-${index}`}
            entry={entry}
            crossedDay={crossedDay}
            needle={needle}
            onCopy={onCopy}
          />
        );
      })}
    </div>
  );
}

function useLogTableState(entries: LogEntry[] | undefined) {
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [requestedPage, setRequestedPage] = useState(1);
  const { needle, visible } = useFilteredLogEntries(entries, search, levelFilter);
  const pageCount = Math.max(1, Math.ceil(visible.length / ENTRIES_PER_PAGE));
  const page = requestedPage > pageCount ? 1 : requestedPage;
  const pageStart = (page - 1) * ENTRIES_PER_PAGE;
  const pageEntries = visible.slice(pageStart, pageStart + ENTRIES_PER_PAGE);
  const updateSearch = (next: string) => {
    setSearch(next);
    setRequestedPage(1);
  };
  const updateLevelFilter = (next: LevelFilter) => {
    setLevelFilter(next);
    setRequestedPage(1);
  };
  return {
    search,
    levelFilter,
    needle,
    visible,
    page,
    pageCount,
    pageStart,
    pageEntries,
    setRequestedPage,
    updateSearch,
    updateLevelFilter,
  };
}

export function LogsSection() {
  const logLevel = useLayoutStore((layout) => layout.logLevel);
  const setLogLevel = useLayoutStore((layout) => layout.setLogLevel);
  const showSuccess = useToastStore((toaster) => toaster.showSuccess);
  const query = useLogEntriesQuery();
  const table = useLogTableState(query.data);

  const handleCopyEntry = (entry: LogEntry) => {
    void navigator.clipboard
      .writeText(entryLine(entry))
      .then(() => showSuccess('Copied log entry.'));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5.5">
      <LogsHeader
        logLevel={logLevel}
        isFetching={query.isFetching}
        onLevelChange={setLogLevel}
        onRefresh={() => void query.refetch()}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-settings-card-line bg-settings-card dark:border-dark-settings-card-line dark:bg-dark-settings-card">
        <LogTableToolbar
          search={table.search}
          levelFilter={table.levelFilter}
          onSearchChange={table.updateSearch}
          onLevelFilterChange={table.updateLevelFilter}
        />
        <LogEntriesViewport
          isLoading={query.isLoading}
          isError={query.isError}
          totalCount={query.data?.length}
          visibleCount={table.visible.length}
          pageEntries={table.pageEntries}
          needle={table.needle}
          onCopy={handleCopyEntry}
        />
        <LogPaginationFooter
          page={table.page}
          pageCount={table.pageCount}
          pageStart={table.pageStart}
          entriesPerPage={ENTRIES_PER_PAGE}
          visibleLength={table.visible.length}
          dataUpdatedAt={query.dataUpdatedAt}
          onSelectPage={table.setRequestedPage}
        />
      </div>
    </div>
  );
}
