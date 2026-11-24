import { useMemo, useState } from 'react';
import { differenceInCalendarDays, format, isToday, isYesterday } from 'date-fns';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, RefreshCw } from 'lucide-react';
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

const ENTRIES_PER_PAGE = 50;

const PAGE_WINDOW = 1;

function pageItems(page: number, pageCount: number): (number | 'ellipsis')[] {
  const items: (number | 'ellipsis')[] = [];
  for (let index = 1; index <= pageCount; index += 1) {
    const isEdge = index === 1 || index === pageCount;
    const isNearCurrent = Math.abs(index - page) <= PAGE_WINDOW;
    if (isEdge || isNearCurrent) {
      items.push(index);
    } else if (items[items.length - 1] !== 'ellipsis') {
      items.push('ellipsis');
    }
  }
  return items;
}

const pageButtonClass =
  'flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-chip text-settings-meta font-semibold tabular-nums text-settings-ink-mute hover:bg-settings-container-low hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary disabled:cursor-not-allowed disabled:opacity-35 aria-[current=true]:bg-settings-container aria-[current=true]:text-settings-on-primary-container dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container-low dark:hover:text-dark-settings-ink dark:aria-[current=true]:bg-dark-settings-container dark:aria-[current=true]:text-dark-settings-on-primary-container';

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

export function LogsSection() {
  const logLevel = useLayoutStore((layout) => layout.logLevel);
  const setLogLevel = useLayoutStore((layout) => layout.setLogLevel);
  const showSuccess = useToastStore((toaster) => toaster.showSuccess);
  const {
    data: entries,
    isLoading,
    isError,
    isFetching,
    refetch,
    dataUpdatedAt,
  } = useLogEntriesQuery();
  const [search, setSearch] = useState('');
  const [levelFilter, setLevelFilter] = useState<LevelFilter>('all');
  const [requestedPage, setRequestedPage] = useState(1);

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

  const pageCount = Math.max(1, Math.ceil(visible.length / ENTRIES_PER_PAGE));
  const page = requestedPage > pageCount ? 1 : requestedPage;
  const pageStart = (page - 1) * ENTRIES_PER_PAGE;
  const pageEntries = visible.slice(pageStart, pageStart + ENTRIES_PER_PAGE);

  const handleCopyEntry = (entry: LogEntry) => {
    void navigator.clipboard
      .writeText(entryLine(entry))
      .then(() => showSuccess('Copied log entry.'));
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-5.5">
      <div className="mx-auto w-full max-w-settings-content-max">
        <SettingsSection
          title="Logs"
          description="Reads today's latentmail.log.YYYY-MM-DD, kept for 7 days."
          actions={
            <button
              type="button"
              onClick={() => void refetch()}
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
              onChange={setLogLevel}
              options={levelOptions}
              className={settingsTriggerClass}
            />
          </SettingRow>
        </SettingsSection>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-settings-card-line bg-settings-card dark:border-dark-settings-card-line dark:bg-dark-settings-card">
        <div className="flex flex-wrap items-center gap-2.5 border-b border-settings-card-line p-3.5 dark:border-dark-settings-card-line">
          <SettingsSearchInput
            value={search}
            ariaLabel="Search log entries"
            placeholder="Search"
            onChange={(next) => {
              setSearch(next);
              setRequestedPage(1);
            }}
            className="min-w-45 flex-1"
          />
          <Select
            ariaLabel="Filter by level"
            value={levelFilter}
            onChange={(next) => {
              setLevelFilter(next);
              setRequestedPage(1);
            }}
            options={levelFilterOptions}
            className={settingsTriggerClass}
          />
        </div>

        <div className="flex gap-3.5 border-b border-b-settings-card-line px-4 py-2 font-mono text-settings-meta uppercase tracking-wide text-settings-ink-mute dark:border-b-dark-settings-card-line dark:text-dark-settings-ink-mute">
          <span className="w-29 shrink-0">Time</span>
          <span className="w-20.5 shrink-0">Level</span>
          <span className="flex-1">Message</span>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {isLoading && <SettingsStateText>Loading log entries…</SettingsStateText>}
          {isError && (
            <SettingsStateText tone="error" role="alert">
              Couldn&apos;t read the log files.
            </SettingsStateText>
          )}
          {!isLoading && !isError && entries?.length === 0 && (
            <SettingsStateText>No log entries found.</SettingsStateText>
          )}
          {!isLoading && !isError && entries && entries.length > 0 && visible.length === 0 && (
            <SettingsStateText>No entries match your search.</SettingsStateText>
          )}
          {pageEntries.map((entry, index) => {
            const previous = pageEntries[index - 1];
            const crossedDay =
              previous !== undefined &&
              differenceInCalendarDays(previous.timestamp, entry.timestamp) > 0;
            const level = entry.level.toLowerCase();
            return (
              <div key={`${entry.timestamp.getTime()}-${index}`}>
                {crossedDay && (
                  <div className="border-y border-settings-card-line bg-settings-container-low px-4 py-2 font-mono text-settings-meta uppercase tracking-wide text-settings-ink-mute dark:border-dark-settings-card-line dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute">
                    {isYesterday(entry.timestamp)
                      ? 'Yesterday'
                      : format(entry.timestamp, DATE_FORMAT.monthDay)}
                  </div>
                )}
                <button
                  type="button"
                  onClick={() => handleCopyEntry(entry)}
                  className={`flex w-full cursor-pointer items-start gap-3.5 border-b border-b-settings-card-line border-l-2 px-4 py-2.25 text-left hover:bg-settings-container-low focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-settings-primary dark:border-b-dark-settings-card-line dark:hover:bg-dark-settings-container-low ${
                    stripeClass[level] ?? 'border-l-transparent'
                  }`}
                >
                  <span className="w-29 shrink-0 font-mono text-settings-meta tabular-nums text-settings-ink-mute dark:text-dark-settings-ink-mute">
                    {timeLabel(entry.timestamp)}
                  </span>
                  <QueueStateChip
                    pipClassName={
                      pipClass[level] ?? 'bg-settings-ink-mute dark:bg-dark-settings-ink-mute'
                    }
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
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-settings-card-line bg-settings-container-low px-4 py-2.5 text-settings-meta text-settings-ink-mute dark:border-dark-settings-card-line dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute">
          <span className="flex items-center gap-3 tabular-nums">
            <span data-testid="log-page-summary" className="inline-block min-w-log-summary">
              {visible.length === 0 ? 0 : pageStart + 1}–
              {Math.min(pageStart + ENTRIES_PER_PAGE, visible.length)} of {visible.length} entries
            </span>
            {pageCount > 1 && (
              <span className="flex items-center gap-0.5">
                <button
                  type="button"
                  aria-label="First page"
                  disabled={page === 1}
                  onClick={() => setRequestedPage(1)}
                  className={pageButtonClass}
                >
                  <ChevronsLeft className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Previous page"
                  disabled={page === 1}
                  onClick={() => setRequestedPage(page - 1)}
                  className={pageButtonClass}
                >
                  <ChevronLeft className="size-3.5" />
                </button>
                {pageItems(page, pageCount).map((item, index) =>
                  item === 'ellipsis' ? (
                    <span
                      key={`ellipsis-${index}`}
                      className="flex size-7 shrink-0 items-center justify-center text-settings-ink-mute dark:text-dark-settings-ink-mute"
                    >
                      …
                    </span>
                  ) : (
                    <button
                      key={item}
                      type="button"
                      aria-current={page === item}
                      onClick={() => setRequestedPage(item)}
                      className={pageButtonClass}
                    >
                      {item}
                    </button>
                  ),
                )}
                <button
                  type="button"
                  aria-label="Next page"
                  disabled={page === pageCount}
                  onClick={() => setRequestedPage(page + 1)}
                  className={pageButtonClass}
                >
                  <ChevronRight className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label="Last page"
                  disabled={page === pageCount}
                  onClick={() => setRequestedPage(pageCount)}
                  className={pageButtonClass}
                >
                  <ChevronsRight className="size-3.5" />
                </button>
              </span>
            )}
          </span>
          {dataUpdatedAt > 0 && (
            <span>
              Last updated {format(new Date(dataUpdatedAt), DATE_FORMAT.timeOfDay)} · auto-refreshes
              every 5s
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
