import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
  name: 'relativeTime',
  standalone: true,
})
export class RelativeTimePipe implements PipeTransform {
  transform(value: string | Date | null | undefined): string {
    if (!value) return '';

    const date = typeof value === 'string' ? new Date(value) : value;
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSecs = Math.floor(diffMs / 1000);
    const diffMins = Math.floor(diffSecs / 60);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    // Today: show time
    if (this.isToday(date, now)) {
      return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    }

    // Yesterday
    if (this.isYesterday(date, now)) {
      return 'Yesterday';
    }

    // Within last 7 days: show day name
    if (diffDays < 7) {
      return date.toLocaleDateString(undefined, { weekday: 'short' });
    }

    // Same year: show month day
    if (date.getFullYear() === now.getFullYear()) {
      return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }

    // Different year: show full date
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  private isToday(date: Date, now: Date): boolean {
    return date.getDate() === now.getDate()
      && date.getMonth() === now.getMonth()
      && date.getFullYear() === now.getFullYear();
  }

  private isYesterday(date: Date, now: Date): boolean {
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    return date.getDate() === yesterday.getDate()
      && date.getMonth() === yesterday.getMonth()
      && date.getFullYear() === yesterday.getFullYear();
  }
}
