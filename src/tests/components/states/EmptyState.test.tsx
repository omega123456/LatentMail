import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmptyState } from '@/components/states/EmptyState';

describe('EmptyState', () => {
  it('renders the plain variant with no spinner', () => {
    render(<EmptyState>Nothing here.</EmptyState>);
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-state-syncing')).not.toBeInTheDocument();
  });

  it('renders the syncing variant with a spinner and n-of-total progress, visually distinct from plain', () => {
    render(
      <EmptyState variant="syncing" persistedCount={12400} discoveredCount={50000}>
        Older mail is still arriving
      </EmptyState>,
    );
    const container = screen.getByTestId('empty-state-syncing');
    expect(container.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.getByText('Older mail is still arriving')).toBeInTheDocument();
    expect(screen.getByText('12,400 of 50,000 so far')).toBeInTheDocument();
  });

  it('omits the progress line when counts are not supplied', () => {
    render(<EmptyState variant="syncing">Still arriving</EmptyState>);
    expect(screen.queryByText(/so far/)).not.toBeInTheDocument();
  });

  it('renders the search variant naming the query and suggesting a next step', () => {
    render(<EmptyState variant="search" query="from:anna quarterly" />);
    const container = screen.getByTestId('empty-state-search');
    expect(container).toHaveTextContent('No results for “from:anna quarterly”');
    expect(
      screen.getByText(/Try fewer words, check the spelling, or widen Search in/),
    ).toBeInTheDocument();
  });
});
