import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { BulkSelectionPanel } from '@/components/actions/BulkSelectionPanel';

function baseHandlers() {
  return {
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onApplyLabels: vi.fn(),
    onMoveTo: vi.fn(),
    onToggleSpam: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe('BulkSelectionPanel', () => {
  it('states the count, the Escape hint, and reuses ActionRibbon inline for bulk actions', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <BulkSelectionPanel
        count={12}
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[]}
        {...handlers}
      />,
    );
    expect(screen.getByText('12 conversations selected')).toBeInTheDocument();
    expect(screen.getByText('Escape clears the selection')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledOnce();
  });

  it('uses singular phrasing for a single selected conversation', () => {
    render(
      <BulkSelectionPanel
        count={1}
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[]}
        {...baseHandlers()}
      />,
    );
    expect(screen.getByText('1 conversation selected')).toBeInTheDocument();
  });
});
