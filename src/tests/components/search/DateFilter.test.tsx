import { useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BLANK_DATE_FILTER,
  DateFilter,
  dateFilterFromPredicates,
  nextFocusedDay,
  serializeDateFilter,
  summariseDateFilter,
  type DateFilterValue,
} from '@/components/search/DateFilter';
import type { SearchPredicate } from '@/lib/types/ipc';

const TODAY = new Date(2026, 7, 17, 12, 0, 0);

function Harness({
  initial = BLANK_DATE_FILTER,
  onChange,
}: {
  initial?: DateFilterValue;
  onChange?: (value: DateFilterValue) => void;
}) {
  const [value, setValue] = useState(initial);
  return (
    <DateFilter
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

function tabbableDays() {
  return screen
    .getAllByRole('gridcell')
    .flatMap((cell) => within(cell).getAllByRole('button'))
    .filter((button) => button.tabIndex === 0);
}

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
  const anchor = new Date(2026, 7, 17);

  it('maps the WAI-ARIA grid keys onto day, week, month and year steps', () => {
    expect(nextFocusedDay('ArrowLeft', false, anchor)).toEqual(new Date(2026, 7, 16));
    expect(nextFocusedDay('ArrowRight', false, anchor)).toEqual(new Date(2026, 7, 18));
    expect(nextFocusedDay('ArrowUp', false, anchor)).toEqual(new Date(2026, 7, 10));
    expect(nextFocusedDay('ArrowDown', false, anchor)).toEqual(new Date(2026, 7, 24));
    expect(nextFocusedDay('Home', false, anchor)).toEqual(new Date(2026, 7, 17));
    expect(nextFocusedDay('End', false, anchor)).toEqual(new Date(2026, 7, 23, 23, 59, 59, 999));
    expect(nextFocusedDay('PageUp', false, anchor)).toEqual(new Date(2026, 6, 17));
    expect(nextFocusedDay('PageDown', false, anchor)).toEqual(new Date(2026, 8, 17));
    expect(nextFocusedDay('PageUp', true, anchor)).toEqual(new Date(2025, 7, 17));
    expect(nextFocusedDay('PageDown', true, anchor)).toEqual(new Date(2027, 7, 17));
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

describe('DateFilter', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(TODAY);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the calendar out of the way until Custom is chosen', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness />);
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Custom…' }));
    expect(screen.getByRole('grid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Before' })).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: 'Custom…' }));
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });

  it('reports the chosen preset in the summary and hands it back to the caller', async () => {
    const user = userEvent.setup({ delay: null });
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: '1 week' }));
    expect(onChange).toHaveBeenCalledWith({ mode: 'preset', preset: '7d', start: '', end: '' });
    expect(screen.getByTestId('date-filter-summary')).toHaveTextContent('Last 7 days');
  });

  it('exposes exactly one tabbable day and moves it with the arrow keys', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness initial={{ mode: 'before', preset: '', start: '', end: '' }} />);

    expect(tabbableDays()).toHaveLength(1);
    expect(tabbableDays()[0]).toHaveAccessibleName('17 August 2026');

    act(() => tabbableDays()[0].focus());
    expect(tabbableDays()[0]).toHaveFocus();

    await user.keyboard('{ArrowRight}');
    expect(tabbableDays()).toHaveLength(1);
    expect(screen.getByRole('button', { name: '18 August 2026' })).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: '25 August 2026' })).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByRole('button', { name: '24 August 2026' })).toHaveFocus();
  });

  it('pages the month with PageDown and announces it in the live heading', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness initial={{ mode: 'before', preset: '', start: '', end: '' }} />);
    const heading = screen.getByRole('grid').getAttribute('aria-labelledby');
    expect(document.getElementById(heading ?? '')).toHaveTextContent('August 2026');

    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(document.getElementById(heading ?? '')).toHaveTextContent('September 2026');

    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    expect(document.getElementById(heading ?? '')).toHaveTextContent('July 2026');
  });

  it('builds a Between range from two clicks and marks both endpoints selected', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness initial={{ mode: 'between', preset: '', start: '', end: '' }} />);
    await user.click(screen.getByRole('button', { name: '4 August 2026' }));
    expect(screen.getByTestId('date-filter-summary')).toHaveTextContent('From 4 Aug 2026');

    await user.click(screen.getByRole('button', { name: '17 August 2026' }));
    expect(screen.getByTestId('date-filter-summary')).toHaveTextContent('4 Aug 2026 – 17 Aug 2026');
    expect(
      screen
        .getAllByRole('gridcell')
        .filter((cell) => cell.getAttribute('aria-selected') === 'true'),
    ).toHaveLength(2);
  });

  it('restarts the range when the second click lands before the first', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness initial={{ mode: 'between', preset: '', start: '', end: '' }} />);
    await user.click(screen.getByRole('button', { name: '17 August 2026' }));
    await user.click(screen.getByRole('button', { name: '4 August 2026' }));
    expect(screen.getByTestId('date-filter-summary')).toHaveTextContent('From 4 Aug 2026');
  });

  it('replaces the date on every click in the single-date modes', async () => {
    const user = userEvent.setup({ delay: null });
    render(<Harness initial={{ mode: 'on', preset: '', start: '', end: '' }} />);
    await user.click(screen.getByRole('button', { name: '4 August 2026' }));
    await user.click(screen.getByRole('button', { name: '11 August 2026' }));
    expect(screen.getByTestId('date-filter-summary')).toHaveTextContent('On 11 Aug 2026');
  });

  it('clears a half-built range when the comparison mode changes', async () => {
    const user = userEvent.setup({ delay: null });
    render(
      <Harness initial={{ mode: 'between', preset: '', start: '2026-08-04', end: '2026-08-17' }} />,
    );
    await user.click(screen.getByRole('button', { name: 'After' }));
    expect(screen.getByTestId('date-filter-summary')).toHaveTextContent('After 4 Aug 2026');
  });

  it('refuses to select a future day', async () => {
    const user = userEvent.setup({ delay: null });
    const onChange = vi.fn();
    render(
      <Harness initial={{ mode: 'before', preset: '', start: '', end: '' }} onChange={onChange} />,
    );
    const future = screen.getByRole('button', { name: '20 August 2026' });
    expect(future).toHaveAttribute('aria-disabled', 'true');
    await user.click(future);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('marks today with aria-current so it stays distinguishable from the selection', () => {
    render(<Harness initial={{ mode: 'before', preset: '', start: '2026-08-04', end: '' }} />);
    expect(screen.getByRole('button', { name: '17 August 2026' })).toHaveAttribute(
      'aria-current',
      'date',
    );
  });

  it('collapses back to the preset chips on Escape without committing', async () => {
    const user = userEvent.setup({ delay: null });
    const onChange = vi.fn();
    render(
      <Harness
        initial={{ mode: 'between', preset: '', start: '2026-08-04', end: '' }}
        onChange={onChange}
      />,
    );
    await user.click(screen.getByRole('button', { name: '11 August 2026' }));
    onChange.mockClear();
    await user.keyboard('{Escape}');
    expect(onChange).toHaveBeenCalledWith(BLANK_DATE_FILTER);
    expect(screen.queryByRole('grid')).not.toBeInTheDocument();
  });
});
