import { useEffect, useMemo, useState } from 'react';
import { differenceInCalendarDays, format, isToday, isYesterday } from 'date-fns';
import { RefreshCw, Search } from 'lucide-react';
import { Select } from '@/components/shared/Select';
import { SettingRow } from '@/components/settings/SettingRow';
import { SettingsSection } from '@/components/settings/SettingsSection';
import { settingsQuietButton, settingsTriggerClass } from '@/components/settings/styles';
import { QueueStateChip } from '@/components/queue/QueueStateChip';
import { useLogEntriesQuery } from '@/lib/query/hooks';
import type { LogEntry } from '@/lib/query/mappers';
import { useLayoutStore } from '@/stores/layout';
import { useToastStore } from '@/stores/toast';
import type { LogLevel } from '@/lib/types/ipc';

const AUTO_REFRESH_INTERVAL_MS = 5_000;
const ENTRIES_PER_PAGE = 50;

const pageButtonClass =
  'cursor-pointer rounded-chip px-1.75 py-1 text-settings-meta font-semibold tabular-nums text-settings-ink-mute hover:bg-settings-container-low hover:text-settings-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-settings-primary disabled:cursor-not-allowed disabled:opacity-35 aria-[current=true]:bg-settings-container aria-[current=true]:text-settings-on-primary-container dark:text-dark-settings-ink-mute dark:hover:bg-dark-settings-container-low dark:hover:text-dark-settings-ink dark:aria-[current=true]:bg-dark-settings-container dark:aria-[current=true]:text-dark-settings-on-primary-container';

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
  return isToday(date) ? format(date, 'HH:mm:ss.SSS') : format(date, 'MMM d · HH:mm:ss.SSS');
}

function entryLine(entry: LogEntry) {
  return `${timeLabel(entry.timestamp)} ${entry.level.toUpperCase()} ${entry.message}`;
}

function Highlighted({ text, needle }: { text: string; needle: string }) {
  if (!needle) return <>{text}</>;
  const index = text.toLowerCase().indexOf(needle);
  if (index < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, index)}
      <mark className="rounded-sm bg-settings-primary-container px-px text-settings-on-primary-container dark:bg-dark-settings-primary-container dark:text-dark-settings-on-primary-container">
        {text.slice(index, index + needle.length)}
      </mark>
      {text.slice(index + needle.length)}
    </>
  );
}

export function LogsSection() {
  const logLevel = useLayoutStore((state) => state.logLevel);
  const setLogLevel = useLayoutStore((state) => state.setLogLevel);
  const showSuccess = useToastStore((state) => state.showSuccess);
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

  useEffect(() => {
    const interval = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refetch();
      }
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refetch]);

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
              <RefreshCw aria-hidden="true" size={15} />
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
          <label className="flex h-8.5 min-w-45 flex-1 items-center gap-1.75 rounded-control border border-transparent bg-settings-container-low px-2.5 text-settings-ink-mute focus-within:border-settings-primary dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute dark:focus-within:border-dark-settings-primary">
            <Search aria-hidden="true" size={14} className="shrink-0" />
            <input
              type="search"
              value={search}
              aria-label="Search log entries"
              placeholder="Search"
              onChange={(event) => {
                setSearch(event.target.value);
                setRequestedPage(1);
              }}
              className="w-full select-text bg-transparent text-settings-desc text-settings-ink outline-none placeholder:text-settings-ink-mute dark:text-dark-settings-ink dark:placeholder:text-dark-settings-ink-mute"
            />
          </label>
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
          {isLoading && (
            <p className="px-4 py-8 text-center text-body-sm text-settings-ink-mute dark:text-dark-settings-ink-mute">
              Loading log entries…
            </p>
          )}
          {isError && (
            <p
              role="alert"
              className="px-4 py-8 text-center text-body-sm text-settings-error dark:text-dark-settings-error"
            >
              Couldn&apos;t read the log files.
            </p>
          )}
          {!isLoading && !isError && entries?.length === 0 && (
            <p className="px-4 py-8 text-center text-body-sm text-settings-ink-mute dark:text-dark-settings-ink-mute">
              No log entries found.
            </p>
          )}
          {!isLoading && !isError && entries && entries.length > 0 && visible.length === 0 && (
            <p className="px-4 py-8 text-center text-body-sm text-settings-ink-mute dark:text-dark-settings-ink-mute">
              No entries match your search.
            </p>
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
                    {isYesterday(entry.timestamp) ? 'Yesterday' : format(entry.timestamp, 'MMM d')}
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
                    <Highlighted text={entry.message} needle={needle} />
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-settings-card-line bg-settings-container-low px-4 py-2.5 text-settings-meta text-settings-ink-mute dark:border-dark-settings-card-line dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute">
          <span className="flex items-center gap-3 tabular-nums">
            <span>
              {visible.length === 0 ? 0 : pageStart + 1}–
              {Math.min(pageStart + ENTRIES_PER_PAGE, visible.length)} of {visible.length} entries
            </span>
            {pageCount > 1 && (
              <span className="flex items-center gap-0.5">
                <button
                  type="button"
                  disabled={page === 1}
                  onClick={() => setRequestedPage(page - 1)}
                  className={pageButtonClass}
                >
                  Prev
                </button>
                {Array.from({ length: pageCount }, (_unused, index) => (
                  <button
                    key={index + 1}
                    type="button"
                    aria-current={page === index + 1}
                    onClick={() => setRequestedPage(index + 1)}
                    className={pageButtonClass}
                  >
                    {index + 1}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={page === pageCount}
                  onClick={() => setRequestedPage(page + 1)}
                  className={pageButtonClass}
                >
                  Next
                </button>
              </span>
            )}
          </span>
          {dataUpdatedAt > 0 && (
            <span>
              Last updated {format(new Date(dataUpdatedAt), 'p')} · auto-refreshes every 5s
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
