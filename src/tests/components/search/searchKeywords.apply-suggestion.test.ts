import { expect, it } from 'vitest';
import { applySuggestion } from '@/components/search/searchKeywords';

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
