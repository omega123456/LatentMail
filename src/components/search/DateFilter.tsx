import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  fromUnixTime,
  isAfter,
  isBefore,
  isSameDay,
  isSameMonth,
  isWithinInterval,
  parseISO,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import type { SearchPredicate } from '@/lib/types/ipc';

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

const WEEK_OPTIONS = { weekStartsOn: 1 } as const;
const ISO_DAY = 'yyyy-MM-dd';

const PRESETS: { value: string; label: string; summary: string }[] = [
  { value: '', label: 'Any time', summary: 'Any time' },
  { value: '1d', label: '1 day', summary: 'Last 24 hours' },
  { value: '7d', label: '1 week', summary: 'Last 7 days' },
  { value: '14d', label: '2 weeks', summary: 'Last 14 days' },
  { value: '1m', label: '1 month', summary: 'Last 30 days' },
  { value: '3m', label: '3 months', summary: 'Last 3 months' },
  { value: '6m', label: '6 months', summary: 'Last 6 months' },
  { value: '1y', label: '1 year', summary: 'Last year' },
];

const MODES: { value: DateFilterMode; label: string }[] = [
  { value: 'before', label: 'Before' },
  { value: 'after', label: 'After' },
  { value: 'on', label: 'On' },
  { value: 'between', label: 'Between' },
];

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

function toIsoDay(atSeconds: number): string {
  return format(fromUnixTime(atSeconds), ISO_DAY);
}

function shiftIsoDay(iso: string, days: number): string {
  return format(addDays(parseISO(iso), days), ISO_DAY);
}

export function serializeDateFilter(value: DateFilterValue): string[] {
  if (value.mode === 'preset') return value.preset ? [`newer_than:${value.preset}`] : [];
  if (!value.start) return [];
  switch (value.mode) {
    case 'before':
      return [`before:${value.start}`];
    case 'after':
      return [`after:${value.start}`];
    case 'on':
      return [`after:${value.start}`, `before:${shiftIsoDay(value.start, 1)}`];
    default:
      return value.end
        ? [`after:${value.start}`, `before:${shiftIsoDay(value.end, 1)}`]
        : [`after:${value.start}`];
  }
}

export function dateFilterFromPredicates(predicates: SearchPredicate[]): {
  value: DateFilterValue;
  remaining: SearchPredicate[];
} {
  const remaining: SearchPredicate[] = [];
  let after: string | null = null;
  let before: string | null = null;
  for (const predicate of predicates) {
    if (predicate.kind === 'sentAfter' && !predicate.negated && after === null)
      after = toIsoDay(predicate.atSeconds);
    else if (predicate.kind === 'sentBefore' && !predicate.negated && before === null)
      before = toIsoDay(predicate.atSeconds);
    else remaining.push(predicate);
  }
  if (after !== null && before !== null) {
    const end = shiftIsoDay(before, -1);
    return {
      value: { mode: after === end ? 'on' : 'between', preset: '', start: after, end },
      remaining,
    };
  }
  if (after !== null)
    return { value: { ...BLANK_DATE_FILTER, mode: 'after', start: after }, remaining };
  if (before !== null)
    return { value: { ...BLANK_DATE_FILTER, mode: 'before', start: before }, remaining };
  return { value: BLANK_DATE_FILTER, remaining };
}

export function summariseDateFilter(value: DateFilterValue): string {
  if (value.mode === 'preset')
    return PRESETS.find((preset) => preset.value === value.preset)?.summary ?? 'Any time';
  if (!value.start) return 'Pick a date';
  const readable = (iso: string) => format(parseISO(iso), 'd MMM yyyy');
  switch (value.mode) {
    case 'before':
      return `Before ${readable(value.start)}`;
    case 'after':
      return `After ${readable(value.start)}`;
    case 'on':
      return `On ${readable(value.start)}`;
    default:
      return value.end
        ? `${readable(value.start)} – ${readable(value.end)}`
        : `From ${readable(value.start)}`;
  }
}

export function nextFocusedDay(key: string, shiftKey: boolean, day: Date): Date | null {
  switch (key) {
    case 'ArrowLeft':
      return addDays(day, -1);
    case 'ArrowRight':
      return addDays(day, 1);
    case 'ArrowUp':
      return addWeeks(day, -1);
    case 'ArrowDown':
      return addWeeks(day, 1);
    case 'Home':
      return startOfWeek(day, WEEK_OPTIONS);
    case 'End':
      return endOfWeek(day, WEEK_OPTIONS);
    case 'PageUp':
      return shiftKey ? addYears(day, -1) : addMonths(day, -1);
    case 'PageDown':
      return shiftKey ? addYears(day, 1) : addMonths(day, 1);
    default:
      return null;
  }
}

const chipClass =
  'cursor-pointer rounded-full border px-2.5 py-1 text-label-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary dark:focus-visible:outline-dark-primary';
const chipOffClass =
  'border-outline-variant/50 text-on-surface-variant hover:bg-surface-container dark:border-dark-outline-variant dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container';
const chipOnClass =
  'border-primary bg-primary text-on-primary dark:border-dark-primary dark:bg-dark-primary dark:text-dark-on-primary';
const modeClass =
  'flex-1 cursor-pointer border-r border-outline-variant/50 py-1.5 text-label-md last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary dark:border-dark-outline-variant dark:focus-visible:outline-dark-primary';
const navClass =
  'flex size-7.5 cursor-pointer items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container-high dark:focus-visible:outline-dark-primary';

export function DateFilter({
  value,
  onChange,
}: {
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
}) {
  const headingId = useId();
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusedDay, setFocusedDay] = useState<Date>(() =>
    value.start ? parseISO(value.start) : startOfDay(new Date()),
  );

  useEffect(() => {
    const grid = gridRef.current;
    if (!grid?.contains(document.activeElement)) return;
    grid.querySelector<HTMLButtonElement>('[data-focused="true"]')?.focus();
  }, [focusedDay]);

  const today = startOfDay(new Date());
  const monthAnchor = startOfMonth(focusedDay);
  const days = eachDayOfInterval({
    start: startOfWeek(monthAnchor, WEEK_OPTIONS),
    end: endOfWeek(endOfMonth(monthAnchor), WEEK_OPTIONS),
  });
  const weeks = days.reduce<Date[][]>((rows, day, index) => {
    if (index % 7 === 0) rows.push([]);
    rows[rows.length - 1].push(day);
    return rows;
  }, []);

  const startDay = value.start ? parseISO(value.start) : null;
  const endDay = value.end ? parseISO(value.end) : null;

  const selectDay = (day: Date) => {
    const iso = format(day, ISO_DAY);
    if (value.mode !== 'between' || !startDay || endDay || isBefore(day, startDay)) {
      onChange({ ...value, start: iso, end: '' });
      return;
    }
    onChange({ ...value, end: iso });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onChange(BLANK_DATE_FILTER);
      return;
    }
    const next = nextFocusedDay(event.key, event.shiftKey, focusedDay);
    if (!next) return;
    event.preventDefault();
    setFocusedDay(next);
  };

  return (
    <div className="flex flex-col gap-2.5 rounded-md border border-outline-variant/40 p-2.5 dark:border-dark-outline-variant">
      <div className="flex items-baseline justify-between">
        <span className="text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant">
          Date
        </span>
        <span
          data-testid="date-filter-summary"
          className="text-label-sm tabular-nums text-primary dark:text-dark-primary"
        >
          {summariseDateFilter(value)}
        </span>
      </div>

      <div role="group" aria-label="Date range" className="flex flex-wrap gap-1">
        {PRESETS.map((preset) => {
          const active = value.mode === 'preset' && value.preset === preset.value;
          return (
            <button
              key={preset.value || 'any'}
              type="button"
              aria-pressed={active}
              onClick={() => onChange({ ...BLANK_DATE_FILTER, preset: preset.value })}
              className={`${chipClass} ${active ? chipOnClass : chipOffClass}`}
            >
              {preset.label}
            </button>
          );
        })}
        <button
          type="button"
          aria-pressed={value.mode !== 'preset'}
          aria-expanded={value.mode !== 'preset'}
          onClick={() =>
            onChange(
              value.mode === 'preset'
                ? { ...BLANK_DATE_FILTER, mode: 'before' }
                : BLANK_DATE_FILTER,
            )
          }
          className={`${chipClass} ${value.mode !== 'preset' ? chipOnClass : chipOffClass}`}
        >
          Custom…
        </button>
      </div>

      {value.mode !== 'preset' && (
        <>
          <div
            role="group"
            aria-label="Date comparison"
            className="flex overflow-hidden rounded border border-outline-variant/50 bg-surface-container-low dark:border-dark-outline-variant dark:bg-dark-surface-container-low"
          >
            {MODES.map((mode) => {
              const active = value.mode === mode.value;
              return (
                <button
                  key={mode.value}
                  type="button"
                  aria-pressed={active}
                  onClick={() => onChange({ ...value, mode: mode.value, end: '' })}
                  className={`${modeClass} ${
                    active
                      ? 'bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary'
                      : 'text-on-surface-variant dark:text-dark-on-surface-variant'
                  }`}
                >
                  {mode.label}
                </button>
              );
            })}
          </div>

          <div className="mx-auto flex w-full max-w-md flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <button
                type="button"
                aria-label="Previous month"
                onClick={() => setFocusedDay(addMonths(focusedDay, -1))}
                className={navClass}
              >
                <ChevronLeft aria-hidden="true" size={16} />
              </button>
              <span
                id={headingId}
                aria-live="polite"
                className="text-label-md uppercase text-on-surface dark:text-dark-on-surface"
              >
                {format(monthAnchor, 'MMMM yyyy')}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setFocusedDay(addMonths(focusedDay, 1))}
                className={navClass}
              >
                <ChevronRight aria-hidden="true" size={16} />
              </button>
            </div>

            <div className="grid grid-cols-7">
              {WEEKDAYS.map((weekday, index) => (
                <span
                  key={`${weekday}-${index}`}
                  aria-hidden="true"
                  className="text-center text-label-sm text-on-surface-variant dark:text-dark-on-surface-variant"
                >
                  {weekday}
                </span>
              ))}
            </div>

            <div
              ref={gridRef}
              role="grid"
              aria-labelledby={headingId}
              className="grid grid-cols-7 gap-y-0.5"
            >
              {weeks.map((week) => (
                <div key={format(week[0], ISO_DAY)} role="row" className="contents">
                  {week.map((day) => {
                    const isStart = startDay !== null && isSameDay(day, startDay);
                    const isEnd = endDay !== null && isSameDay(day, endDay);
                    const selected = isStart || isEnd;
                    const inRange =
                      startDay !== null &&
                      endDay !== null &&
                      isWithinInterval(day, { start: startDay, end: endDay });
                    const disabled = isAfter(day, today);
                    const focused = isSameDay(day, focusedDay);
                    const bandClass = !inRange
                      ? ''
                      : `bg-secondary-container dark:bg-dark-secondary-container ${isStart ? 'rounded-l-full' : ''} ${isEnd ? 'rounded-r-full' : ''}`;
                    return (
                      <div
                        key={format(day, ISO_DAY)}
                        role="gridcell"
                        aria-selected={selected}
                        className={`flex h-9.5 items-center justify-center ${bandClass}`}
                      >
                        <button
                          type="button"
                          data-focused={focused}
                          tabIndex={focused ? 0 : -1}
                          aria-disabled={disabled}
                          aria-current={isSameDay(day, today) ? 'date' : undefined}
                          aria-label={format(day, 'd MMMM yyyy')}
                          onClick={() => !disabled && selectDay(day)}
                          onFocus={() => setFocusedDay(day)}
                          onKeyDown={handleKeyDown}
                          className={`flex size-8.5 cursor-pointer items-center justify-center rounded-full text-body-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary dark:focus-visible:outline-dark-primary ${
                            selected
                              ? 'bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary'
                              : disabled
                                ? 'cursor-default text-outline-variant dark:text-dark-outline-variant'
                                : !isSameMonth(day, monthAnchor)
                                  ? 'text-outline hover:bg-surface-container-high dark:text-dark-outline dark:hover:bg-dark-surface-container-high'
                                  : isSameDay(day, today)
                                    ? 'text-primary inset-ring inset-ring-primary dark:text-dark-primary dark:inset-ring-dark-primary'
                                    : 'text-on-surface hover:bg-surface-container-high dark:text-dark-on-surface dark:hover:bg-dark-surface-container-high'
                          }`}
                        >
                          {format(day, 'd')}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
