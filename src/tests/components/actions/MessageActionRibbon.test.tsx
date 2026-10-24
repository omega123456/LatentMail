import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MessageActionRibbon } from '@/components/actions/MessageActionRibbon';

function baseHandlers() {
  return {
    onToggleRead: vi.fn(),
    onToggleStar: vi.fn(),
    onApplyLabels: vi.fn(),
    onMoveTo: vi.fn(),
    onToggleSpam: vi.fn(),
    onDelete: vi.fn(),
    onReply: vi.fn(),
    onReplyAll: vi.fn(),
    onForward: vi.fn(),
  };
}

describe('MessageActionRibbon', () => {
  it('is present without any hover interaction and is reachable by keyboard', () => {
    render(
      <MessageActionRibbon
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[]}
        {...baseHandlers()}
      />,
    );
    const ribbon = screen.getByRole('toolbar', { name: 'Message actions' });
    expect(ribbon).toBeInTheDocument();
    const deleteButton = screen.getByRole('button', { name: 'Delete' });
    expect(deleteButton).not.toHaveAttribute('disabled');
    deleteButton.focus();
    expect(deleteButton).toHaveFocus();
  });

  it('dispatches star and delete for the whole conversation from a single message', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[]}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Star' }));
    expect(handlers.onToggleStar).toHaveBeenCalledOnce();
    await user.click(screen.getByRole('button', { name: 'Delete' }));
    expect(handlers.onDelete).toHaveBeenCalledOnce();
  });

  it('opens Labels and applies a change', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[{ id: 'Label_1', name: 'Clients', color: 'blue', membership: 'unchecked' }]}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Labels' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: /Clients/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(handlers.onApplyLabels).toHaveBeenCalledWith({ add: ['Label_1'], remove: [] });
  });

  it('opens Move to and dispatches a destination', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[]}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Move to' }));
    await user.click(await screen.findByRole('menuitem', { name: /Trash/ }));
    expect(handlers.onMoveTo).toHaveBeenCalledWith('TRASH');
  });

  it('dispatches spam toggle', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[]}
        {...handlers}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark as spam' }));
    expect(handlers.onToggleSpam).toHaveBeenCalledOnce();
  });

  it('dispatches read toggle', async () => {
    const user = userEvent.setup();
    const handlers = baseHandlers();
    render(
      <MessageActionRibbon systemLabelIds={[]} unread starred={false} labels={[]} {...handlers} />,
    );
    await user.click(screen.getByRole('button', { name: 'Mark read' }));
    expect(handlers.onToggleRead).toHaveBeenCalledOnce();
  });

  it('hides every label-mutating action in Drafts', () => {
    render(
      <MessageActionRibbon
        systemLabelIds={['DRAFT']}
        unread={false}
        starred={false}
        labels={[]}
        {...baseHandlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Star' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Labels' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
  });

  it('hides star and delete for a message carrying TRASH, based on its own label membership', () => {
    render(
      <MessageActionRibbon
        systemLabelIds={['TRASH']}
        unread={false}
        starred={false}
        labels={[]}
        {...baseHandlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Star' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Move to' })).toBeInTheDocument();
  });

  it('offers no overflow menu when the message has no export actions', () => {
    render(
      <MessageActionRibbon
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[]}
        {...baseHandlers()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'More message actions' })).not.toBeInTheDocument();
  });

  it('places the overflow menu after Delete and dispatches each export action', async () => {
    const user = userEvent.setup();
    const exportActions = {
      onShowOriginal: vi.fn(),
      onDownloadEml: vi.fn(),
      onDownloadHtml: vi.fn(),
    };
    render(
      <MessageActionRibbon
        systemLabelIds={[]}
        unread={false}
        starred={false}
        labels={[]}
        {...baseHandlers()}
        exportActions={exportActions}
      />,
    );
    const buttons = screen.getAllByRole('button');
    expect(buttons.at(-1)).toHaveAccessibleName('More message actions');
    expect(buttons.at(-2)).toHaveAccessibleName('Delete');

    await user.click(screen.getByRole('button', { name: 'More message actions' }));
    expect(screen.getByRole('menuitem', { name: /Show original/ })).toHaveTextContent('Ctrl+U');
    await user.click(screen.getByRole('menuitem', { name: /Show original/ }));
    await user.click(screen.getByRole('button', { name: 'More message actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download message (.eml)' }));
    await user.click(screen.getByRole('button', { name: 'More message actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Download as web page (.html)' }));

    expect(exportActions.onShowOriginal).toHaveBeenCalledTimes(1);
    expect(exportActions.onDownloadEml).toHaveBeenCalledTimes(1);
    expect(exportActions.onDownloadHtml).toHaveBeenCalledTimes(1);
  });
});
