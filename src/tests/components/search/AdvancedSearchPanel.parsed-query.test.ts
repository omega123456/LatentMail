import { expect, it } from 'vitest';
import { fieldsFromParsedQuery, serializeFields } from '@/components/search/AdvancedSearchPanel';
import type { ParsedSearchQuery } from '@/lib/types/ipc';

it('maps from/to/subject/includes/excludes and unnegated checkboxes directly', () => {
  const parsed: ParsedSearchQuery = {
    hasTextTerm: true,
    from: 'anna',
    to: null,
    subject: 'quarterly',
    includes: ['invoice'],
    excludes: ['draft'],
    predicates: [
      { kind: 'hasAttachment', negated: false },
      { kind: 'unread', negated: false },
    ],
  };
  expect(fieldsFromParsedQuery(parsed)).toMatchObject({
    from: 'anna',
    subject: 'quarterly',
    includesText: 'invoice',
    excludesText: 'draft',
    hasAttachment: true,
    unreadOnly: true,
  });
});

it('keeps unrepresentable operators (label:, is:starred, negated checkboxes) as free text', () => {
  const parsed: ParsedSearchQuery = {
    hasTextTerm: true,
    from: null,
    to: null,
    subject: null,
    includes: ['budget'],
    excludes: [],
    predicates: [
      { kind: 'label', value: 'Work', negated: false },
      { kind: 'starred', negated: false },
      { kind: 'hasAttachment', negated: true },
    ],
  };
  const fields = fieldsFromParsedQuery(parsed);
  expect(fields.includesText).toContain('budget');
  expect(fields.includesText).toContain('label:Work');
  expect(fields.includesText).toContain('is:starred');
  expect(fields.includesText).toContain('-has:attachment');
  expect(fields.hasAttachment).toBe(false);
});

it('reconstructs a Before filter from an unnegated sentBefore predicate', () => {
  const parsed: ParsedSearchQuery = {
    hasTextTerm: true,
    from: null,
    to: null,
    subject: null,
    includes: [],
    excludes: [],
    predicates: [{ kind: 'sentBefore', atSeconds: 1704672000, negated: false }],
  };
  expect(fieldsFromParsedQuery(parsed).date).toEqual({
    mode: 'before',
    preset: '',
    start: '2024-01-08',
    end: '',
  });
});

it('cannot reconstruct the relative preset from a sentAfter predicate — the parser resolves newer_than:Xd to an absolute epoch, so the round trip keeps it as an equivalent After filter rather than re-selecting the preset chip', () => {
  const parsed: ParsedSearchQuery = {
    hasTextTerm: true,
    from: null,
    to: null,
    subject: null,
    includes: [],
    excludes: [],
    predicates: [{ kind: 'sentAfter', atSeconds: 1704672000, negated: false }],
  };
  const fields = fieldsFromParsedQuery(parsed);
  expect(fields.date).toEqual({ mode: 'after', preset: '', start: '2024-01-08', end: '' });
  expect(fields.includesText).toBe('');
  expect(serializeFields(fields)).toBe('after:2024-01-08');
});
