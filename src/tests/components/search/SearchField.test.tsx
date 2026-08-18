import { act, fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { SearchField } from '@/components/search/SearchField';
import { useSearchStore } from '@/stores/search';
import { useToastStore } from '@/stores/toast';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

beforeEach(() => {
  act(() => {
    useSearchStore.setState({
      draft: '',
      submittedQuery: '',
      scope: { kind: 'default' },
      active: false,
      panelOpen: false,
    });
    useToastStore.setState({ toasts: [] });
  });
});

describe('SearchField', () => {
  it('submits the trimmed draft on Enter', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.type(field, '  from:anna  ');
    await user.keyboard('{Enter}');
    expect(useSearchStore.getState().submittedQuery).toBe('from:anna');
    expect(useSearchStore.getState().active).toBe(true);
  });

  it('does nothing on Enter with a blank field', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    await user.click(screen.getByLabelText('Search mail'));
    await user.keyboard('{Enter}');
    expect(useSearchStore.getState().active).toBe(false);
  });

  it('shows the clear control once there is text and hides the shortcut hint', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    expect(screen.getByText('⌘F')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Search mail'), 'anna');
    expect(screen.queryByText('⌘F')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Clear search')).toBeInTheDocument();
  });

  it('Escape with text clears search but keeps focus in the field', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.type(field, 'anna');
    await user.keyboard('{Enter}');
    await user.keyboard('{Escape}');
    expect(useSearchStore.getState().active).toBe(false);
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();
  });

  it('Escape on an empty field blurs it', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.click(field);
    expect(field).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(field).not.toHaveFocus();
  });

  it('the clear control clears search', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.type(field, 'anna');
    await user.keyboard('{Enter}');
    await user.click(screen.getByLabelText('Clear search'));
    expect(useSearchStore.getState().active).toBe(false);
    expect(field).toHaveValue('');
  });

  it('rejects an over-long query with a visible reason and does not activate search', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.click(field);
    fireEvent.change(field, { target: { value: 'x'.repeat(2049) } });
    await user.keyboard('{Enter}');
    expect(useSearchStore.getState().active).toBe(false);
    expect(useToastStore.getState().toasts.at(-1)?.message).toMatch(/2048 characters/);
  });

  it('submits the query the advanced panel serialises, and reflects it back into the field', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    await user.click(screen.getByRole('button', { name: 'Show search options' }));
    await user.type(screen.getByLabelText('From'), 'anna');
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(useSearchStore.getState().submittedQuery).toBe('from:anna');
    expect(screen.getByLabelText('Search mail')).toHaveValue('from:anna');
    expect(screen.queryByTestId('advanced-search-panel')).not.toBeInTheDocument();
  });

  it('toggles the advanced panel open and closed via the disclosure chevron', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    expect(screen.queryByTestId('advanced-search-panel')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show search options' }));
    expect(screen.getByTestId('advanced-search-panel')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide search options' }));
    expect(screen.queryByTestId('advanced-search-panel')).not.toBeInTheDocument();
  });

  it('shows keyword suggestions while typing an operator name', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    await user.type(screen.getByLabelText('Search mail'), 'fro');
    expect(screen.getByRole('listbox', { name: 'Search suggestions' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /from:/ })).toBeInTheDocument();
  });

  it('ArrowDown then Enter applies the active suggestion instead of submitting', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.type(field, 'fro');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(field).toHaveValue('from:');
    expect(useSearchStore.getState().active).toBe(false);
  });

  it('shows the value suggestions for is: and applying one keeps the trailing space', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.type(field, 'is:');
    expect(screen.getAllByRole('option')).toHaveLength(4);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(field).toHaveValue('is:unread ');
  });

  it('Enter with no active suggestion still submits', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.type(field, 'fro');
    await user.keyboard('{Enter}');
    expect(useSearchStore.getState().submittedQuery).toBe('fro');
    expect(useSearchStore.getState().active).toBe(true);
  });

  it('Tab applies the first suggestion when none is active', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.type(field, 'fro');
    await user.keyboard('{Tab}');
    expect(field).toHaveValue('from:');
  });

  it('Escape closes the suggestion popup without clearing the draft', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<SearchField labels={[]} />);
    const field = screen.getByLabelText('Search mail');
    await user.type(field, 'fro');
    expect(screen.getByRole('listbox', { name: 'Search suggestions' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox', { name: 'Search suggestions' })).not.toBeInTheDocument();
    expect(field).toHaveValue('fro');
  });

  it('a label suggestion inserts the label id', async () => {
    const user = userEvent.setup();
    renderWithQueryClient(
      <SearchField
        labels={[
          {
            id: 'Label_1',
            name: 'Work',
            kind: 'user',
            color: null,
            messageCount: 0,
            unreadCount: 0,
          },
        ]}
      />,
    );
    const field = screen.getByLabelText('Search mail');
    await user.type(field, 'label:wo');
    await user.click(screen.getByRole('option', { name: /Work/ }));
    expect(field).toHaveValue('label:Label_1 ');
  });
});
