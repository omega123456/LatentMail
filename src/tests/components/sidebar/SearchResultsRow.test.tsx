import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CollapsedSearchIndicator, SearchResultsRow } from '@/components/sidebar/SearchResultsRow';

describe('SearchResultsRow', () => {
  it('shows the query and the true total as a status message', () => {
    render(<SearchResultsRow query="from:anna" total={7} onClose={vi.fn()} />);
    const row = screen.getByTestId('search-results-row');
    expect(row).toHaveTextContent('from:anna');
    expect(screen.getByRole('status')).toHaveTextContent('Search · 7 results');
  });

  it('says no results for a zero total', () => {
    render(<SearchResultsRow query="from:nobody" total={0} onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Search · no results');
  });

  it('caps a very large total at 999+', () => {
    render(<SearchResultsRow query="has:attachment" total={5000} onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Search · 999+ results');
  });

  it('says searching while pending, regardless of a stale total', () => {
    render(<SearchResultsRow query="from:anna" total={7} pending onClose={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Search · searching…');
  });

  it('calls onClose from the clear control', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<SearchResultsRow query="from:anna" total={7} onClose={onClose} />);
    await user.click(screen.getByLabelText('Clear search results'));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('CollapsedSearchIndicator', () => {
  it('carries the query as its tooltip', () => {
    render(<CollapsedSearchIndicator query="from:anna" />);
    expect(screen.getByTestId('collapsed-search-indicator')).toHaveAttribute('title', 'from:anna');
  });
});
