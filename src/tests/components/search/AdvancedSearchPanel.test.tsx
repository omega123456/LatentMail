import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import {
  AdvancedSearchPanel,
  fieldsFromParsedQuery,
  predicateToToken,
  serializeFields,
} from '@/components/search/AdvancedSearchPanel';
import type { MailLabel, ParsedSearchQuery } from '@/lib/types/ipc';
import { ipc } from '@/tests/ipc-mock';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

const labels: MailLabel[] = [
  {
    id: 'Label_1',
    name: 'Receipts',
    kind: 'user',
    color: null,
    messageCount: 0,
    unreadCount: 0,
  },
];

describe('serializeFields', () => {
  it('templates every field into its operator token, quoting values with spaces', () => {
    expect(
      serializeFields({
        from: 'Anna Kim',
        to: 'ops@example.com',
        subject: 'quarterly',
        includesText: 'invoice',
        excludesText: 'draft -spam',
        durationValue: '7d',
        dateValue: '2026-01-08',
        hasAttachment: true,
        unreadOnly: true,
      }),
    ).toBe(
      'from:"Anna Kim" to:ops@example.com subject:quarterly invoice -draft -spam newer_than:7d before:2026-01-08 has:attachment is:unread',
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
        durationValue: '',
        dateValue: '',
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
        durationValue: '',
        dateValue: '',
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

describe('fieldsFromParsedQuery', () => {
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

  it('reconstructs the date field from an unnegated sentBefore predicate', () => {
    const parsed: ParsedSearchQuery = {
      hasTextTerm: true,
      from: null,
      to: null,
      subject: null,
      includes: [],
      excludes: [],
      predicates: [{ kind: 'sentBefore', atSeconds: 1704672000, negated: false }],
    };
    expect(fieldsFromParsedQuery(parsed).dateValue).toBe('2024-01-08');
  });

  it('cannot reconstruct the relative "Date within" duration from a sentAfter predicate — the parser resolves newer_than:Xd to an absolute epoch, so the round trip keeps it as a literal, re-submittable after: token instead of repopulating the duration select', () => {
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
    expect(fields.durationValue).toBe('');
    expect(fields.includesText).toBe('after:2024-01-08');
    expect(serializeFields(fields)).toBe('after:2024-01-08');
  });
});

describe('AdvancedSearchPanel', () => {
  it('submits the serialized fields and closes via the overlay', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    renderWithQueryClient(
      <AdvancedSearchPanel
        initialQuery=""
        labels={labels}
        scope={{ kind: 'default' }}
        onScopeChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    await user.type(screen.getByLabelText('From'), 'anna');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSubmit).toHaveBeenCalledWith('from:anna');

    await user.click(screen.getByTestId('advanced-search-panel-overlay'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('fills every field and serializes them all on submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithQueryClient(
      <AdvancedSearchPanel
        initialQuery=""
        labels={labels}
        scope={{ kind: 'default' }}
        onScopeChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('From'), 'anna');
    await user.type(screen.getByLabelText('To'), 'ops');
    await user.type(screen.getByLabelText('Subject'), 'quarterly');
    await user.type(screen.getByLabelText('Includes the words'), 'invoice');
    await user.type(screen.getByLabelText('Doesn’t have'), 'draft');
    await user.selectOptions(screen.getByLabelText('Date within'), '7d');
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: '2026-01-08' } });
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSubmit).toHaveBeenCalledWith(
      'from:anna to:ops subject:quarterly invoice -draft newer_than:7d before:2026-01-08',
    );
  });

  it('does nothing when Search is clicked with every field blank', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithQueryClient(
      <AdvancedSearchPanel
        initialQuery=""
        labels={labels}
        scope={{ kind: 'default' }}
        onScopeChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits with only the checkboxes ticked', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithQueryClient(
      <AdvancedSearchPanel
        initialQuery=""
        labels={labels}
        scope={{ kind: 'default' }}
        onScopeChange={vi.fn()}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await user.click(screen.getByLabelText('Has attachment'));
    await user.click(screen.getByLabelText('Unread only'));
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(onSubmit).toHaveBeenCalledWith('has:attachment is:unread');
  });

  it('reconstructs its fields from an existing query via parse_search_query', async () => {
    ipc.override('parse_search_query', {
      hasTextTerm: true,
      from: 'anna',
      to: null,
      subject: null,
      includes: [],
      excludes: [],
      predicates: [{ kind: 'hasAttachment', negated: false }],
    });
    renderWithQueryClient(
      <AdvancedSearchPanel
        initialQuery="from:anna has:attachment"
        labels={labels}
        scope={{ kind: 'default' }}
        onScopeChange={vi.fn()}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('From')).toHaveValue('anna'));
    expect(screen.getByLabelText('Has attachment')).toBeChecked();
  });

  it('resets every field back to blank', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <AdvancedSearchPanel
        initialQuery=""
        labels={labels}
        scope={{ kind: 'default' }}
        onScopeChange={vi.fn()}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await user.type(screen.getByLabelText('From'), 'anna');
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(screen.getByLabelText('From')).toHaveValue('');
  });

  it('offers user labels plus Inbox, Sent and the two whole-mailbox options in Search in', async () => {
    const onScopeChange = vi.fn();
    const user = userEvent.setup();
    renderWithQueryClient(
      <AdvancedSearchPanel
        initialQuery=""
        labels={labels}
        scope={{ kind: 'default' }}
        onScopeChange={onScopeChange}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const select = screen.getByLabelText('Search in');
    expect(screen.getByRole('option', { name: 'Receipts' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Inbox' })).toBeInTheDocument();
    expect(
      screen.getByRole('option', { name: 'All mail including Trash and Spam' }),
    ).toBeInTheDocument();
    await user.selectOptions(select, JSON.stringify({ kind: 'all' }));
    expect(onScopeChange).toHaveBeenCalledWith({ kind: 'all' });
  });
});
