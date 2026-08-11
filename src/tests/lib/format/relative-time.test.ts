import { describe, expect, it } from 'vitest';
import { exactTime, relativeTime } from '@/lib/format/relative-time';

describe('relativeTime', () => {
  const now = new Date('2026-08-11T12:00:00Z');
  it.each([
    ['today', '2026-08-11T09:30:00Z', '9:30 AM'],
    ['yesterday', '2026-08-10T09:30:00Z', 'Yesterday'],
    ['weekday', '2026-08-07T09:30:00Z', 'Friday'],
    ['this year', '2026-07-01T09:30:00Z', 'Jul 1'],
    ['older', '2025-07-01T09:30:00Z', 'Jul 1, 2025'],
  ])('formats %s timestamps', (_name, value, expected) =>
    expect(relativeTime(new Date(value), now)).toBe(expected),
  );
  it('provides an exact timestamp for the tooltip', () =>
    expect(exactTime(new Date('2026-08-11T09:30:00Z'))).toBe('Aug 11, 2026, 9:30 AM'));
});
