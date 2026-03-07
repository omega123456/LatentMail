import { Pipe, PipeTransform } from '@angular/core';
import { DateTime } from 'luxon';

@Pipe({
  name: 'relativeTime',
  standalone: true,
})
export class RelativeTimePipe implements PipeTransform {
  transform(value: string | Date | null | undefined): string {
    if (!value) {
      return '';
    }

    const dt = typeof value === 'string' ? DateTime.fromISO(value) : DateTime.fromJSDate(value);

    if (!dt.isValid) {
      return '';
    }

    const diff = DateTime.now().diff(dt, ['days', 'hours', 'minutes', 'seconds']);

    // Today: show time
    if (dt.hasSame(DateTime.now(), 'day')) {
      return dt.toLocaleString(DateTime.TIME_SIMPLE);
    }

    // Yesterday
    if (dt.hasSame(DateTime.now().minus({ days: 1 }), 'day')) {
      return 'Yesterday';
    }

    // Within last 7 days: show short weekday name
    if (diff.as('days') < 7) {
      return dt.toFormat('ccc');
    }

    // Same year: show month and day
    if (dt.hasSame(DateTime.now(), 'year')) {
      return dt.toLocaleString({ month: 'short', day: 'numeric' });
    }

    // Different year: show full date
    return dt.toLocaleString({ month: 'short', day: 'numeric', year: 'numeric' });
  }
}
