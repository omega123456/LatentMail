import { describe, expect, it, vi } from 'vitest';
import {
  basename,
  errorMessageOr,
  extensionOf,
  formatCount,
  pluralize,
} from '@/lib/format/strings';
import { clamp, intersectAll, toggleInSet, wrapIndex } from '@/lib/collections';
import { createDebouncedFlush, createDebouncedTrigger } from '@/lib/debounced-flush';
import {
  readToggleIntent,
  selectedRowIds,
  spamToggleIntent,
  starToggleIntent,
} from '@/lib/triage/intents';

describe('string format helpers', () => {
  it('pluralizes and formats counts', () => {
    const two = 2;
    const five = 5;
    expect(pluralize(1, 'message')).toBe('message');
    expect(pluralize(two, 'message')).toBe('messages');
    expect(pluralize(0, 'entry', 'entries')).toBe('entries');
    expect(formatCount(1, 'minute')).toBe('1 minute');
    expect(formatCount(five, 'minute')).toBe('5 minutes');
  });

  it('extracts error messages with fallback', () => {
    expect(errorMessageOr(new Error('boom'), 'fallback')).toBe('boom');
    expect(errorMessageOr(new Error(''), 'fallback')).toBe('fallback');
    expect(errorMessageOr('plain', 'fallback')).toBe('plain');
    expect(errorMessageOr(null, 'fallback')).toBe('fallback');
  });

  it('extracts basename and extension', () => {
    expect(basename('/tmp/report.pdf')).toBe('report.pdf');
    expect(basename('C:\\Users\\docs\\notes.txt')).toBe('notes.txt');
    expect(basename('plain')).toBe('plain');
    expect(extensionOf('archive.TAR.GZ')).toBe('gz');
    expect(extensionOf('README')).toBe('');
  });
});

describe('collection helpers', () => {
  it('clamps, wraps indexes, toggles sets and intersects lists', () => {
    const belowMin = 5;
    const min = 10;
    const insideRange = 15;
    const max = 20;
    const aboveMax = 25;
    expect(clamp(belowMin, min, max)).toBe(min);
    expect(clamp(aboveMax, min, max)).toBe(max);
    expect(clamp(insideRange, min, max)).toBe(insideRange);

    const lastIndex = 2;
    const listLength = 3;
    expect(wrapIndex(0, -1, listLength)).toBe(lastIndex);
    expect(wrapIndex(lastIndex, 1, listLength)).toBe(0);
    expect(wrapIndex(0, 1, 0)).toBe(0);

    const initial = new Set(['alpha']);
    const added = toggleInSet(initial, 'beta');
    expect([...added]).toEqual(['alpha', 'beta']);
    const removed = toggleInSet(added, 'alpha');
    expect([...removed]).toEqual(['beta']);

    expect(intersectAll([])).toEqual([]);
    expect(
      intersectAll([
        ['INBOX', 'STARRED'],
        ['INBOX', 'UNREAD'],
      ]),
    ).toEqual(['INBOX']);
  });
});

describe('debounced flush helpers', () => {
  it('batches items and cancels pending flushes', () => {
    vi.useFakeTimers();
    const delayMs = 50;
    const flushed: string[][] = [];
    const batcher = createDebouncedFlush<string>(delayMs, (items) => flushed.push([...items]));
    batcher.add('a1');
    batcher.add('a2');
    vi.advanceTimersByTime(delayMs);
    expect(flushed).toEqual([['a1', 'a2']]);

    batcher.add('a3');
    batcher.cancel();
    vi.advanceTimersByTime(delayMs);
    expect(flushed).toEqual([['a1', 'a2']]);

    const triggered = vi.fn();
    const trigger = createDebouncedTrigger(delayMs, triggered);
    trigger.trigger();
    trigger.trigger();
    vi.advanceTimersByTime(delayMs);
    expect(triggered).toHaveBeenCalledTimes(1);

    trigger.trigger();
    trigger.cancel();
    vi.advanceTimersByTime(delayMs);
    expect(triggered).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});

describe('triage intent helpers', () => {
  it('builds star, read, spam intents and row selections', () => {
    expect(starToggleIntent(false)).toEqual({ kind: 'label', add: ['STARRED'], remove: [] });
    expect(starToggleIntent(true)).toEqual({ kind: 'label', add: [], remove: ['STARRED'] });
    expect(readToggleIntent(false)).toEqual({ kind: 'label', add: ['UNREAD'], remove: [] });
    expect(readToggleIntent(true)).toEqual({ kind: 'label', add: [], remove: ['UNREAD'] });
    expect(spamToggleIntent(false)).toEqual({ kind: 'move', destination: 'SPAM' });
    expect(spamToggleIntent(true)).toEqual({ kind: 'move', destination: 'INBOX' });

    const selected = new Set(['t1', 't2']);
    expect(selectedRowIds('t1', selected, true)).toEqual(['t1', 't2']);
    expect(selectedRowIds('t3', selected, true)).toEqual(['t3']);
    expect(selectedRowIds('t1', selected, false)).toEqual(['t1']);
  });
});
