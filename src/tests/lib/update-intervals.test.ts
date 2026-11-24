import { hoursToMilliseconds } from 'date-fns';
import { millisecondsInDay, millisecondsInWeek } from 'date-fns/constants';
import { describe, expect, it } from 'vitest';
import { UPDATE_INTERVAL_MS, UPDATE_INTERVAL_OPTIONS } from '@/lib/update-intervals';

describe('update-intervals', () => {
  it('lists an option for every update check interval, ending with off', () => {
    expect(UPDATE_INTERVAL_OPTIONS.map((option) => option.value)).toEqual([
      '1h',
      '5h',
      '1d',
      '7d',
      'off',
    ]);
  });

  it('converts every non-off interval to milliseconds', () => {
    expect(UPDATE_INTERVAL_MS['1h']).toBe(hoursToMilliseconds(1));
    expect(UPDATE_INTERVAL_MS['5h']).toBe(hoursToMilliseconds(5));
    expect(UPDATE_INTERVAL_MS['1d']).toBe(millisecondsInDay);
    expect(UPDATE_INTERVAL_MS['7d']).toBe(millisecondsInWeek);
  });
});
