import { describe, expect, it } from 'vitest';
import { predicateToToken, serializeFields } from '@/components/search/AdvancedSearchPanel';
import { BLANK_DATE_FILTER } from '@/components/search/DateFilter';

describe('serializeFields', () => {
  it('templates every field into its operator token, quoting values with spaces', () => {
    expect(
      serializeFields({
        from: 'Anna Kim',
        to: 'ops@example.com',
        subject: 'quarterly',
        includesText: 'invoice',
        excludesText: 'draft -spam',
        date: { mode: 'preset', preset: '7d', start: '', end: '' },
        hasAttachment: true,
        unreadOnly: true,
      }),
    ).toBe(
      'from:"Anna Kim" to:ops@example.com subject:quarterly invoice -draft -spam newer_than:7d has:attachment is:unread',
    );
  });

  it('produces a predicate-only query when only checkboxes are set', () => {
    expect(
      serializeFields({
        from: '',
        to: '',
        subject: '',
        includesText: '',
        excludesText: '',
        date: BLANK_DATE_FILTER,
        hasAttachment: true,
        unreadOnly: true,
      }),
    ).toBe('has:attachment is:unread');
  });

  it('produces an empty string for entirely blank fields', () => {
    expect(
      serializeFields({
        from: '',
        to: '',
        subject: '',
        includesText: '',
        excludesText: '',
        date: BLANK_DATE_FILTER,
        hasAttachment: false,
        unreadOnly: false,
      }),
    ).toBe('');
  });
});

describe('predicateToToken', () => {
  it('renders every representable predicate kind, negated or not', () => {
    expect(predicateToToken({ kind: 'label', value: 'Work', negated: false })).toBe('label:Work');
    expect(predicateToToken({ kind: 'label', value: 'Work', negated: true })).toBe('-label:Work');
    expect(predicateToToken({ kind: 'starred', negated: false })).toBe('is:starred');
    expect(predicateToToken({ kind: 'hasAttachment', negated: true })).toBe('-has:attachment');
    expect(predicateToToken({ kind: 'unread', negated: true })).toBe('-is:unread');
    expect(predicateToToken({ kind: 'sentBefore', atSeconds: 1704672000, negated: false })).toBe(
      'before:2024-01-08',
    );
    expect(predicateToToken({ kind: 'sentAfter', atSeconds: 1704672000, negated: false })).toBe(
      'after:2024-01-08',
    );
  });

  it('has no reconstructible text for a textExcludes predicate', () => {
    expect(predicateToToken({ kind: 'textExcludes', negated: true })).toBeNull();
  });
});
