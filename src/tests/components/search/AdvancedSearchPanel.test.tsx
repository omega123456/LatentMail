import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AdvancedSearchPanel } from '@/components/search/AdvancedSearchPanel';
import type { MailLabel } from '@/lib/types/ipc';
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
  await user.click(screen.getByRole('button', { name: '1 week' }));
  await user.click(screen.getByRole('button', { name: 'Search' }));
  expect(onSubmit).toHaveBeenCalledWith(
    'from:anna to:ops subject:quarterly invoice -draft newer_than:7d',
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
  await user.click(screen.getByLabelText('Search in'));
  expect(screen.getByRole('option', { name: 'Receipts' })).toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'Inbox' })).toBeInTheDocument();
  await user.click(screen.getByRole('option', { name: 'Mail, Spam and Trash' }));
  expect(onScopeChange).toHaveBeenCalledWith({ kind: 'all' });
});
