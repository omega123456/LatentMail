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
import { ICON_SIZE } from '@/components/shared/icon-size';
import { DATE_FORMAT } from '@/lib/format/date-formats';
import {
  BLANK_DATE_FILTER,
  PRESETS,
  dateFilterFromPredicates,
  serializeDateFilter,
  summariseDateFilter,
  type DateFilterMode,
  type DateFilterValue,
} from '@/lib/search/grammar';

export {
  BLANK_DATE_FILTER,
  PRESETS,
  dateFilterFromPredicates,
  serializeDateFilter,
  summariseDateFilter,
  type DateFilterMode,
  type DateFilterValue,
};

const WEEK_OPTIONS = { weekStartsOn: 1 } as const;

const MODES: { value: DateFilterMode; label: string }[] = [
  { value: 'before', label: 'Before' },
  { value: 'after', label: 'After' },
  { value: 'on', label: 'On' },
  { value: 'between', label: 'Between' },
];

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

const DAY_NAVIGATION: Record<string, (day: Date, shiftKey: boolean) => Date> = {
  ArrowLeft: (day) => addDays(day, -1),
  ArrowRight: (day) => addDays(day, 1),
  ArrowUp: (day) => addWeeks(day, -1),
  ArrowDown: (day) => addWeeks(day, 1),
  Home: (day) => startOfWeek(day, WEEK_OPTIONS),
  End: (day) => endOfWeek(day, WEEK_OPTIONS),
  PageUp: (day, shiftKey) => (shiftKey ? addYears(day, -1) : addMonths(day, -1)),
  PageDown: (day, shiftKey) => (shiftKey ? addYears(day, 1) : addMonths(day, 1)),
};

export function nextFocusedDay(key: string, shiftKey: boolean, day: Date): Date | null {
  const move = DAY_NAVIGATION[key];
  return move ? move(day, shiftKey) : null;
}

function dayButtonClass(input: {
  selected: boolean;
  disabled: boolean;
  sameMonth: boolean;
  isToday: boolean;
}): string {
  if (input.selected)
    return 'bg-primary text-on-primary dark:bg-dark-primary dark:text-dark-on-primary';
  if (input.disabled) return 'cursor-default text-outline-variant dark:text-dark-outline-variant';
  if (!input.sameMonth) {
    return 'text-outline hover:bg-surface-container-high dark:text-dark-outline dark:hover:bg-dark-surface-container-high';
  }
  if (input.isToday) {
    return 'text-primary inset-ring inset-ring-primary dark:text-dark-primary dark:inset-ring-dark-primary';
  }
  return 'text-on-surface hover:bg-surface-container-high dark:text-dark-on-surface dark:hover:bg-dark-surface-container-high';
}

function rangeBandClass(inRange: boolean, isStart: boolean, isEnd: boolean): string {
  if (!inRange) return '';
  const startCap = isStart ? 'rounded-l-full' : '';
  const endCap = isEnd ? 'rounded-r-full' : '';
  return `bg-secondary-container dark:bg-dark-secondary-container ${startCap} ${endCap}`;
}

function DayCell({
  day,
  today,
  monthAnchor,
  startDay,
  endDay,
  focusedDay,
  onSelectDay,
  onFocusDay,
  onKeyDown,
}: {
  day: Date;
  today: Date;
  monthAnchor: Date;
  startDay: Date | null;
  endDay: Date | null;
  focusedDay: Date;
  onSelectDay: (day: Date) => void;
  onFocusDay: (day: Date) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const isStart = startDay !== null && isSameDay(day, startDay);
  const isEnd = endDay !== null && isSameDay(day, endDay);
  const selected = isStart || isEnd;
  const inRange =
    startDay !== null && endDay !== null && isWithinInterval(day, { start: startDay, end: endDay });
  const disabled = isAfter(day, today);
  const focused = isSameDay(day, focusedDay);
  const isToday = isSameDay(day, today);
  const toneClass = dayButtonClass({
    selected: selected,
    disabled: disabled,
    sameMonth: isSameMonth(day, monthAnchor),
    isToday: isToday,
  });
  return (
    <div
      role="gridcell"
      aria-selected={selected}
      className={`flex h-9.5 items-center justify-center ${rangeBandClass(inRange, isStart, isEnd)}`}
    >
      <button
        type="button"
        data-focused={focused}
        tabIndex={focused ? 0 : -1}
        aria-disabled={disabled}
        aria-current={isToday ? 'date' : undefined}
        aria-label={format(day, DATE_FORMAT.longDayMonthYear)}
        onClick={() => !disabled && onSelectDay(day)}
        onFocus={() => onFocusDay(day)}
        onKeyDown={onKeyDown}
        className={`flex size-8.5 cursor-pointer items-center justify-center rounded-full text-body-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary dark:focus-visible:outline-dark-primary ${toneClass}`}
      >
        {format(day, DATE_FORMAT.dayOfMonth)}
      </button>
    </div>
  );
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
    if (index % WEEKDAYS.length === 0) rows.push([]);
    rows[rows.length - 1].push(day);
    return rows;
  }, []);

  const startDay = value.start ? parseISO(value.start) : null;
  const endDay = value.end ? parseISO(value.end) : null;

  const selectDay = (day: Date) => {
    const iso = format(day, DATE_FORMAT.isoDate);
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
                <ChevronLeft aria-hidden="true" size={ICON_SIZE.base} />
              </button>
              <span
                id={headingId}
                aria-live="polite"
                className="text-label-md uppercase text-on-surface dark:text-dark-on-surface"
              >
                {format(monthAnchor, DATE_FORMAT.monthYear)}
              </span>
              <button
                type="button"
                aria-label="Next month"
                onClick={() => setFocusedDay(addMonths(focusedDay, 1))}
                className={navClass}
              >
                <ChevronRight aria-hidden="true" size={ICON_SIZE.base} />
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
                <div key={format(week[0], DATE_FORMAT.isoDate)} role="row" className="contents">
                  {week.map((day) => (
                    <DayCell
                      key={format(day, DATE_FORMAT.isoDate)}
                      day={day}
                      today={today}
                      monthAnchor={monthAnchor}
                      startDay={startDay}
                      endDay={endDay}
                      focusedDay={focusedDay}
                      onSelectDay={selectDay}
                      onFocusDay={setFocusedDay}
                      onKeyDown={handleKeyDown}
                    />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
