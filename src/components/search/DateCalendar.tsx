import { ChevronLeft, ChevronRight } from 'lucide-react';
import {
  addMonths,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  format,
  isAfter,
  isSameDay,
  isSameMonth,
  isWithinInterval,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { ICON_SIZE } from '@/components/shared/icon-size';
import { DATE_FORMAT } from '@/lib/format/date-formats';

export const WEEK_OPTIONS = { weekStartsOn: 1 } as const;
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const navClass =
  'flex size-7.5 cursor-pointer items-center justify-center rounded text-on-surface-variant hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary dark:text-dark-on-surface-variant dark:hover:bg-dark-surface-container-high dark:focus-visible:outline-dark-primary';

function buildCalendarWeeks(monthAnchor: Date): Date[][] {
  const days = eachDayOfInterval({
    start: startOfWeek(monthAnchor, WEEK_OPTIONS),
    end: endOfWeek(endOfMonth(monthAnchor), WEEK_OPTIONS),
  });
  return days.reduce<Date[][]>((rows, day, index) => {
    if (index % WEEKDAYS.length === 0) rows.push([]);
    rows[rows.length - 1].push(day);
    return rows;
  }, []);
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

type DayCellProps = {
  day: Date;
  today: Date;
  monthAnchor: Date;
  startDay: Date | null;
  endDay: Date | null;
  focusedDay: Date;
  onSelectDay: (day: Date) => void;
  onFocusDay: (day: Date) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
};

function DayCell(props: DayCellProps) {
  const { day, today, monthAnchor, startDay, endDay, focusedDay } = props;
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
        onClick={() => !disabled && props.onSelectDay(day)}
        onFocus={() => props.onFocusDay(day)}
        onKeyDown={props.onKeyDown}
        className={`flex size-8.5 cursor-pointer items-center justify-center rounded-full text-body-sm tabular-nums focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-primary dark:focus-visible:outline-dark-primary ${toneClass}`}
      >
        {format(day, DATE_FORMAT.dayOfMonth)}
      </button>
    </div>
  );
}

function CalendarMonthHeader({
  headingId,
  monthAnchor,
  focusedDay,
  onFocusDay,
}: {
  headingId: string;
  monthAnchor: Date;
  focusedDay: Date;
  onFocusDay: (day: Date) => void;
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <button
          type="button"
          aria-label="Previous month"
          onClick={() => onFocusDay(addMonths(focusedDay, -1))}
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
          onClick={() => onFocusDay(addMonths(focusedDay, 1))}
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
    </>
  );
}

type CalendarMonthPickerProps = {
  headingId: string;
  gridRef: React.RefObject<HTMLDivElement | null>;
  focusedDay: Date;
  startDay: Date | null;
  endDay: Date | null;
  onSelectDay: (day: Date) => void;
  onFocusDay: (day: Date) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => void;
};

export function CalendarMonthPicker({
  headingId,
  gridRef,
  focusedDay,
  startDay,
  endDay,
  onSelectDay,
  onFocusDay,
  onKeyDown,
}: CalendarMonthPickerProps) {
  const today = startOfDay(new Date());
  const monthAnchor = startOfMonth(focusedDay);
  const weeks = buildCalendarWeeks(monthAnchor);
  return (
    <div className="mx-auto flex w-full max-w-md flex-col gap-1.5">
      <CalendarMonthHeader
        headingId={headingId}
        monthAnchor={monthAnchor}
        focusedDay={focusedDay}
        onFocusDay={onFocusDay}
      />
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
                onSelectDay={onSelectDay}
                onFocusDay={onFocusDay}
                onKeyDown={onKeyDown}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
