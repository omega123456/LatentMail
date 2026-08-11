import { differenceInCalendarDays, format } from 'date-fns';

export function relativeTime(date: Date, now = new Date()) {
  const age = differenceInCalendarDays(now, date);
  if (age === 0) return format(date, 'p');
  if (age === 1) return 'Yesterday';
  if (age < 7) return format(date, 'EEEE');
  return format(date, date.getFullYear() === now.getFullYear() ? 'MMM d' : 'MMM d, yyyy');
}

export function exactTime(date: Date) {
  return format(date, 'MMM d, yyyy, p');
}
