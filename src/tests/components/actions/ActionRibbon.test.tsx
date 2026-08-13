import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ActionRibbon, computeRibbonVisibility } from '@/components/actions/ActionRibbon';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';

const labels: LabelMenuEntry[] = [
  { id: 'Label_1', name: 'Clients', color: 'blue', membership: 'unchecked' },
];

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

describe('computeRibbonVisibility', () => {
  it('hides every label-mutating action in Drafts, leaving only delete', () => {
    const visibility = computeRibbonVisibility('DRAFT');
    expect(visibility).toMatchObject({
      showReadToggle: false,
      showStar: false,
      showLabels: false,
      showMoveTo: false,
      showSpamToggle: false,
      showDelete: true,
    });
  });

  it('hides star and delete in Trash', () => {
    const visibility = computeRibbonVisibility('TRASH');
    expect(visibility.showStar).toBe(false);
    expect(visibility.showDelete).toBe(false);
  });

  it('swaps to notSpam mode in Spam', () => {
    expect(computeRibbonVisibility('SPAM').spamMode).toBe('notSpam');
    expect(computeRibbonVisibility('INBOX').spamMode).toBe('markSpam');
  });
});

describe('ActionRibbon', () => {
  it('renders the full action set in Inbox and dispatches read/star/delete', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(<ActionRibbon mailboxId="INBOX" unread starred={false} labels={labels} {...handlers} />);
    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(handlers.onToggleRead).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Star' }));
    expect(handlers.onToggleStar).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Mark as spam' }));
    expect(handlers.onToggleSpam).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Mark as spam' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to' })).toBeInTheDocument();
  });

  it('shows Not spam instead of Mark as spam while browsing Spam', () => {
    render(
      <ActionRibbon
        mailboxId="SPAM"
        unread={false}
        starred={false}
        labels={labels}
        {...baseHandlers()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Not spam' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark as spam' })).not.toBeInTheDocument();
  });

  it('renders only the read toggle and delete in Drafts', () => {
    render(
      <ActionRibbon
        mailboxId="DRAFT"
        unread={false}
        starred={false}
        labels={labels}
        {...baseHandlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Star' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Labels' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Move to' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('hides star and delete in Trash', () => {
    render(
      <ActionRibbon
        mailboxId="TRASH"
        unread={false}
        starred={false}
        labels={labels}
        {...baseHandlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Star' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to' })).toBeInTheDocument();
  });

  it('moves triage actions into overflow one pixel below their measured required width, keeping reply, read/unread and delete outside it', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <ActionRibbon
        mailboxId="INBOX"
        unread={false}
        starred={false}
        labels={labels}
        {...handlers}
      />,
    );
    // The measured implementation fits at equality and overflows at one
    // pixel less. jsdom needs explicit ResizeObserver measurements.
    act(() => {
      const observers = window.__resizeObserverInstances__ ?? [];
      observers[0]?.callback(
        [{ contentRect: { width: 320 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
      observers[1]?.callback(
        [{ contentRect: { width: 321 } } as ResizeObserverEntry],
        {} as ResizeObserver,
      );
    });
    expect(await screen.findByRole('button', { name: 'More actions' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Star' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark unread' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('button', { name: 'Star' }));
    expect(handlers.onToggleStar).toHaveBeenCalledOnce();
  });

  it('opens the Move to menu and dispatches the chosen destination', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <ActionRibbon
        mailboxId="INBOX"
        unread={false}
        starred={false}
        labels={labels}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Move to' }));
    await user.click(await screen.findByRole('menuitem', { name: /Spam/ }));
    expect(handlers.onMoveTo).toHaveBeenCalledWith('SPAM');
  });
});
