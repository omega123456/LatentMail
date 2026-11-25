import { useState } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  BLANK_DATE_FILTER,
  DateFilter,
  type DateFilterValue,
} from '@/components/search/DateFilter';
import { parseISO } from 'date-fns';

const TODAY = parseISO('2026-08-17T12:00:00');
const RANGE_ENDPOINT_COUNT = 2;

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
    screen.getAllByRole('gridcell').filter((cell) => cell.getAttribute('aria-selected') === 'true'),
  ).toHaveLength(RANGE_ENDPOINT_COUNT);
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
