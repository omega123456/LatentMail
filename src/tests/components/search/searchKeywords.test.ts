import { describe, expect, it } from 'vitest';
import { applySuggestion, suggestionsFor } from '@/components/search/searchKeywords';
import type { MailLabel } from '@/lib/types/ipc';

const labels: MailLabel[] = [
  { id: 'Label_1', name: 'Work', kind: 'user', color: null, messageCount: 0, unreadCount: 0 },
  {
    id: 'Label_2',
    name: 'Side Project',
    kind: 'user',
    color: null,
    messageCount: 0,
    unreadCount: 0,
  },
];

describe('suggestionsFor', () => {
  it('matches keyword names by prefix', () => {
    const result = suggestionsFor('fro', labels);
    expect(result).toEqual([{ insert: 'from:', primary: 'from:', secondary: 'Sender' }]);
  });

  it('returns no suggestions for an empty draft', () => {
    expect(suggestionsFor('', labels)).toEqual([]);
    expect(suggestionsFor('   ', labels)).toEqual([]);
  });

  it('returns no suggestions for an unknown key', () => {
    expect(suggestionsFor('bogus:x', labels)).toEqual([]);
  });

  it('lists all is: values when the value is empty', () => {
    const result = suggestionsFor('is:', labels);
    expect(result.map((item) => item.insert)).toEqual([
      'is:unread',
      'is:read',
      'is:starred',
      'is:unstarred',
    ]);
  });

  it('filters is: values by prefix', () => {
    const result = suggestionsFor('is:st', labels);
    expect(result.map((item) => item.insert)).toEqual(['is:starred']);
  });

  it('offers duration presets for newer_than:', () => {
    const result = suggestionsFor('newer_than:1', labels);
    expect(result.map((item) => item.insert)).toEqual([
      'newer_than:1d',
      'newer_than:14d',
      'newer_than:1m',
      'newer_than:1y',
    ]);
  });

  it('matches labels by name and inserts the id', () => {
    const result = suggestionsFor('label:wo', labels);
    expect(result).toEqual([{ insert: 'label:Label_1', primary: 'Work', secondary: 'Label_1' }]);
  });

  it('quotes a label id containing a space', () => {
    const spaced: MailLabel[] = [
      { id: 'My Label', name: 'Side', kind: 'user', color: null, messageCount: 0, unreadCount: 0 },
    ];
    const result = suggestionsFor('label:si', spaced);
    expect(result).toEqual([
      { insert: 'label:"My Label"', primary: 'Side', secondary: 'My Label' },
    ]);
  });

  it('preserves negation on both keyword and value suggestions', () => {
    expect(suggestionsFor('-is:unr', labels)).toEqual([
      { insert: '-is:unread', primary: 'is:unread' },
    ]);
    expect(suggestionsFor('-fro', labels)).toEqual([
      { insert: '-from:', primary: 'from:', secondary: 'Sender' },
    ]);
  });
});

describe('applySuggestion', () => {
  it('replaces the first token in an otherwise empty draft', () => {
    expect(applySuggestion('fro', 'from:')).toBe('from:');
  });

  it('replaces only the trailing token, keeping earlier ones intact', () => {
    expect(applySuggestion('from:anna is:unr', 'is:unread')).toBe('from:anna is:unread ');
  });

  it('leaves no trailing space after a bare key', () => {
    expect(applySuggestion('fro', 'from:')).not.toMatch(/ $/);
  });

  it('adds a trailing space after a complete key:value', () => {
    expect(applySuggestion('is:unr', 'is:unread')).toBe('is:unread ');
  });
});
