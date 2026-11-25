import { describe, expect, it } from 'vitest';
import {
  BLANK_DATE_FILTER,
  dateFilterFromPredicates,
  nextFocusedDay,
  serializeDateFilter,
  summariseDateFilter,
} from '@/components/search/DateFilter';
import type { SearchPredicate } from '@/lib/types/ipc';
import { parseISO } from 'date-fns';

describe('serializeDateFilter', () => {
  it('emits newer_than for a preset and nothing for Any time', () => {
    expect(serializeDateFilter({ mode: 'preset', preset: '7d', start: '', end: '' })).toEqual([
      'newer_than:7d',
    ]);
    expect(serializeDateFilter(BLANK_DATE_FILTER)).toEqual([]);
  });

  it('emits a single operator for Before and After', () => {
    expect(
      serializeDateFilter({ mode: 'before', preset: '', start: '2026-08-12', end: '' }),
    ).toEqual(['before:2026-08-12']);
    expect(
      serializeDateFilter({ mode: 'after', preset: '', start: '2026-08-12', end: '' }),
    ).toEqual(['after:2026-08-12']);
  });

  it('brackets a single day for On, since before: is exclusive of its date', () => {
    expect(serializeDateFilter({ mode: 'on', preset: '', start: '2026-08-12', end: '' })).toEqual([
      'after:2026-08-12',
      'before:2026-08-13',
    ]);
  });

  it('makes both ends of a Between range inclusive to the user', () => {
    expect(
      serializeDateFilter({ mode: 'between', preset: '', start: '2026-08-04', end: '2026-08-17' }),
    ).toEqual(['after:2026-08-04', 'before:2026-08-18']);
  });

  it('degrades a half-picked Between range to an open-ended After', () => {
    expect(
      serializeDateFilter({ mode: 'between', preset: '', start: '2026-08-04', end: '' }),
    ).toEqual(['after:2026-08-04']);
  });

  it('emits nothing for a custom mode with no date picked yet', () => {
    expect(serializeDateFilter({ mode: 'between', preset: '', start: '', end: '' })).toEqual([]);
  });
});

describe('dateFilterFromPredicates', () => {
  it('reads a lone sentBefore as Before and a lone sentAfter as After', () => {
    expect(
      dateFilterFromPredicates([{ kind: 'sentBefore', atSeconds: 1704672000, negated: false }])
        .value,
    ).toEqual({ mode: 'before', preset: '', start: '2024-01-08', end: '' });
    expect(
      dateFilterFromPredicates([{ kind: 'sentAfter', atSeconds: 1704672000, negated: false }])
        .value,
    ).toEqual({ mode: 'after', preset: '', start: '2024-01-08', end: '' });
  });

  it('pairs sentAfter with sentBefore into an inclusive Between range', () => {
    expect(
      dateFilterFromPredicates([
        { kind: 'sentAfter', atSeconds: 1704672000, negated: false },
        { kind: 'sentBefore', atSeconds: 1705968000, negated: false },
      ]).value,
    ).toEqual({ mode: 'between', preset: '', start: '2024-01-08', end: '2024-01-22' });
  });

  it('collapses a one-day range back to On', () => {
    expect(
      dateFilterFromPredicates([
        { kind: 'sentAfter', atSeconds: 1704672000, negated: false },
        { kind: 'sentBefore', atSeconds: 1704758400, negated: false },
      ]).value,
    ).toEqual({ mode: 'on', preset: '', start: '2024-01-08', end: '2024-01-08' });
  });

  it('leaves negated and unrelated predicates for the caller to render as text', () => {
    const predicates: SearchPredicate[] = [
      { kind: 'sentBefore', atSeconds: 1704672000, negated: true },
      { kind: 'starred', negated: false },
    ];
    const { value, remaining } = dateFilterFromPredicates(predicates);
    expect(value).toEqual(BLANK_DATE_FILTER);
    expect(remaining).toEqual(predicates);
  });
});

describe('nextFocusedDay', () => {
  const anchor = parseISO('2026-08-17');

  it('maps the WAI-ARIA grid keys onto day, week, month and year steps', () => {
    expect(nextFocusedDay('ArrowLeft', false, anchor)).toEqual(parseISO('2026-08-16'));
    expect(nextFocusedDay('ArrowRight', false, anchor)).toEqual(parseISO('2026-08-18'));
    expect(nextFocusedDay('ArrowUp', false, anchor)).toEqual(parseISO('2026-08-10'));
    expect(nextFocusedDay('ArrowDown', false, anchor)).toEqual(parseISO('2026-08-24'));
    expect(nextFocusedDay('Home', false, anchor)).toEqual(parseISO('2026-08-17'));
    expect(nextFocusedDay('End', false, anchor)).toEqual(parseISO('2026-08-23T23:59:59.999'));
    expect(nextFocusedDay('PageUp', false, anchor)).toEqual(parseISO('2026-07-17'));
    expect(nextFocusedDay('PageDown', false, anchor)).toEqual(parseISO('2026-09-17'));
    expect(nextFocusedDay('PageUp', true, anchor)).toEqual(parseISO('2025-08-17'));
    expect(nextFocusedDay('PageDown', true, anchor)).toEqual(parseISO('2027-08-17'));
  });

  it('ignores keys outside the grid map', () => {
    expect(nextFocusedDay('a', false, anchor)).toBeNull();
    expect(nextFocusedDay('Enter', false, anchor)).toBeNull();
  });
});

describe('summariseDateFilter', () => {
  it('names the active preset, or the picked dates once Custom is in play', () => {
    expect(summariseDateFilter(BLANK_DATE_FILTER)).toBe('Any time');
    expect(summariseDateFilter({ mode: 'preset', preset: '1m', start: '', end: '' })).toBe(
      'Last 30 days',
    );
    expect(summariseDateFilter({ mode: 'before', preset: '', start: '', end: '' })).toBe(
      'Pick a date',
    );
    expect(summariseDateFilter({ mode: 'before', preset: '', start: '2026-08-12', end: '' })).toBe(
      'Before 12 Aug 2026',
    );
    expect(summariseDateFilter({ mode: 'after', preset: '', start: '2026-08-12', end: '' })).toBe(
      'After 12 Aug 2026',
    );
    expect(summariseDateFilter({ mode: 'on', preset: '', start: '2026-08-12', end: '' })).toBe(
      'On 12 Aug 2026',
    );
    expect(
      summariseDateFilter({ mode: 'between', preset: '', start: '2026-08-04', end: '2026-08-17' }),
    ).toBe('4 Aug 2026 – 17 Aug 2026');
    expect(summariseDateFilter({ mode: 'between', preset: '', start: '2026-08-04', end: '' })).toBe(
      'From 4 Aug 2026',
    );
  });

  it('falls back to Any time for a preset the chip row no longer offers', () => {
    expect(summariseDateFilter({ mode: 'preset', preset: '99y', start: '', end: '' })).toBe(
      'Any time',
    );
  });
});
