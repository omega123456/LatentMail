import { differenceInCalendarDays, format } from 'date-fns';
import { DATE_FORMAT } from '@/lib/format/date-formats';

const DAYS_PER_WEEK = 7;

export function relativeTime(date: Date, now = new Date()) {
  const age = differenceInCalendarDays(now, date);
  if (age === 0) return format(date, DATE_FORMAT.timeOfDay);
  if (age === 1) return 'Yesterday';
  if (age < DAYS_PER_WEEK) return format(date, DATE_FORMAT.weekday);
  return format(
    date,
    date.getFullYear() === now.getFullYear() ? DATE_FORMAT.monthDay : DATE_FORMAT.monthDayYear,
  );
}

export function exactTime(date: Date) {
  return format(date, DATE_FORMAT.exactDateTime);
}
