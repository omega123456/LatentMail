import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RowContextMenu } from '@/components/actions/RowContextMenu';
import type { LabelMenuEntry } from '@/components/actions/LabelsMenu';

const labels: LabelMenuEntry[] = [
  { id: 'Label_1', name: 'Clients', color: 'blue', membership: 'checked' },
];

function baseHandlers() {
  return {
    onOpen: vi.fn(),
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onMoveTo: vi.fn(),
    onToggleLabel: vi.fn(),
    onToggleSpam: vi.fn(),
    onDelete: vi.fn(),
  };
}

describe('RowContextMenu', () => {
  it('opens at a right-click and lists entries in the wireframe order', async () => {
    const user = userEvent.setup();
    render(
      <RowContextMenu systemLabelIds={[]} unread starred={false} labels={labels} {...baseHandlers()}>
        <div>row</div>
      </RowContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    const menu = await screen.findByRole('menu');
    const names = Array.from(menu.querySelectorAll('[role="menuitem"]')).map(
      (item) => item.textContent,
    );
    expect(names[0]).toContain('Open');
    expect(names.at(-1)).toContain('Delete');
  });

  it('dispatches Open, star, and delete', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <RowContextMenu
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={labels}
        {...handlers}
      >
        <div>row</div>
      </RowContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    await user.click(await screen.findByText('Open'));
    expect(handlers.onOpen).toHaveBeenCalledOnce();

    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    await user.click(await screen.findByText('Star'));
    expect(handlers.onToggleStar).toHaveBeenCalledOnce();

    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    await user.click(await screen.findByText('Delete'));
    expect(handlers.onDelete).toHaveBeenCalledOnce();
  });

  it('opens the Move to submenu via pointer and dispatches a destination', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <RowContextMenu
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={labels}
        {...handlers}
      >
        <div>row</div>
      </RowContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    await user.hover(await screen.findByText('Move to'));

    fireEvent.click(await screen.findByRole('menuitem', { name: /Trash/ }));
    expect(handlers.onMoveTo).toHaveBeenCalledWith('TRASH');
    expect(screen.queryByRole('menu', { name: 'Move to' })).not.toBeInTheDocument();
  });

  it('relabels entries with the selection count when multi-selected', async () => {
    const user = userEvent.setup();
    render(
      <RowContextMenu
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={labels}
        selectionCount={3}
        {...baseHandlers()}
      >
        <div>row</div>
      </RowContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    expect(screen.queryByText('Open')).not.toBeInTheDocument();
    expect(await screen.findByText('Delete 3')).toBeInTheDocument();
    expect(screen.getByText('Star 3')).toBeInTheDocument();
  });

  it('swaps to "Mark as not spam" while browsing Spam', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <RowContextMenu systemLabelIds={['SPAM']} unread={false} starred={false} labels={labels} {...handlers}>
        <div>row</div>
      </RowContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    await user.click(await screen.findByText('Mark as not spam'));
    expect(handlers.onToggleSpam).toHaveBeenCalledOnce();
  });

  it('hides label-mutating entries in Drafts, leaving Delete', async () => {
    const user = userEvent.setup();
    render(
      <RowContextMenu
        systemLabelIds={['DRAFT']}
        unread={false}
        starred={false}
        labels={labels}
        {...baseHandlers()}
      >
        <div>row</div>
      </RowContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    expect(screen.queryByText('Star')).not.toBeInTheDocument();
    expect(screen.queryByText('Move to')).not.toBeInTheDocument();
    expect(screen.queryByText('Labels')).not.toBeInTheDocument();
    expect(await screen.findByText('Delete')).toBeInTheDocument();
  });

  it('shows Trash-appropriate affordances for a row carrying TRASH, regardless of which mailbox is currently selected', async () => {
    const user = userEvent.setup();
    render(
      <RowContextMenu
        systemLabelIds={['TRASH']}
        unread={false}
        starred={false}
        labels={labels}
        {...baseHandlers()}
      >
        <div>row</div>
      </RowContextMenu>,
    );
    await user.pointer({ keys: '[MouseRight]', target: screen.getByText('row') });
    expect(screen.queryByText('Star')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    expect(await screen.findByText('Move to')).toBeInTheDocument();
  });
});
