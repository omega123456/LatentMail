import { useEffect, useId, useRef, useState } from 'react';
import {
  addDays,
  addMonths,
  addWeeks,
  addYears,
  endOfWeek,
  format,
  isBefore,
  parseISO,
  startOfDay,
  startOfWeek,
} from 'date-fns';
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
import { CalendarMonthPicker, WEEK_OPTIONS } from './DateCalendar';

export {
  BLANK_DATE_FILTER,
  PRESETS,
  dateFilterFromPredicates,
  serializeDateFilter,
  summariseDateFilter,
  type DateFilterMode,
  type DateFilterValue,
};

const MODES: { value: DateFilterMode; label: string }[] = [
  { value: 'before', label: 'Before' },
  { value: 'after', label: 'After' },
  { value: 'on', label: 'On' },
  { value: 'between', label: 'Between' },
];

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

const chipClass =
  'cursor-pointer rounded-full border px-2.5 py-1 text-label-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary dark:focus-visible:outline-dark-primary';
const chipOffClass =
  'border-outline-variant/50 text-on-surface-variant hover:bg-surface-container dark:border-dark-outline-variant dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container';
const chipOnClass =
  'border-primary bg-primary text-on-primary dark:border-dark-primary dark:bg-dark-primary dark:text-dark-on-primary';
const modeClass =
  'flex-1 cursor-pointer border-r border-outline-variant/50 py-1.5 text-label-md last:border-r-0 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-primary dark:border-dark-outline-variant dark:focus-visible:outline-dark-primary';

function DatePresetBar({
  value,
  onChange,
}: {
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
}) {
  const isCustom = value.mode !== 'preset';
  return (
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
        aria-pressed={isCustom}
        aria-expanded={isCustom}
        onClick={() =>
          onChange(isCustom ? BLANK_DATE_FILTER : { ...BLANK_DATE_FILTER, mode: 'before' })
        }
        className={`${chipClass} ${isCustom ? chipOnClass : chipOffClass}`}
      >
        Custom…
      </button>
    </div>
  );
}

function DateModeBar({
  value,
  onChange,
}: {
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
}) {
  return (
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
  );
}

function useDateFilterCalendar(value: DateFilterValue, onChange: (value: DateFilterValue) => void) {
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusedDay, setFocusedDay] = useState<Date>(() =>
    value.start ? parseISO(value.start) : startOfDay(new Date()),
  );
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid?.contains(document.activeElement)) return;
    grid.querySelector<HTMLButtonElement>('[data-focused="true"]')?.focus();
  }, [focusedDay]);
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
  return { gridRef, focusedDay, setFocusedDay, startDay, endDay, selectDay, handleKeyDown };
}

export function DateFilter({
  value,
  onChange,
}: {
  value: DateFilterValue;
  onChange: (value: DateFilterValue) => void;
}) {
  const headingId = useId();
  const calendar = useDateFilterCalendar(value, onChange);

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
      <DatePresetBar value={value} onChange={onChange} />
      {value.mode !== 'preset' && (
        <>
          <DateModeBar value={value} onChange={onChange} />
          <CalendarMonthPicker
            headingId={headingId}
            gridRef={calendar.gridRef}
            focusedDay={calendar.focusedDay}
            startDay={calendar.startDay}
            endDay={calendar.endDay}
            onSelectDay={calendar.selectDay}
            onFocusDay={calendar.setFocusedDay}
            onKeyDown={calendar.handleKeyDown}
          />
        </>
      )}
    </div>
  );
}
