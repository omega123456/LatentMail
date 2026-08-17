import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CollapsedSearchIndicator, SearchResultsRow } from '@/components/sidebar/SearchResultsRow';

describe('SearchResultsRow', () => {
  it('shows the query text and the true total in a live region', () => {
    render(<SearchResultsRow query="from:anna" total={7} onClose={vi.fn()} />);
    const row = screen.getByTestId('search-results-row');
    expect(row).toHaveTextContent('from:anna');
    const total = screen.getByText('7');
    expect(total).toHaveAttribute('aria-live', 'polite');
    expect(total).toHaveAttribute('aria-atomic', 'true');
  });

  it('calls onClose from the close control', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SearchResultsRow query="from:anna" total={7} onClose={onClose} />);
    await user.click(screen.getByLabelText('Close search'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('CollapsedSearchIndicator', () => {
  it('carries the query as its tooltip', () => {
    render(<CollapsedSearchIndicator query="from:anna" />);
    expect(screen.getByTestId('collapsed-search-indicator')).toHaveAttribute('title', 'from:anna');
  });
});
