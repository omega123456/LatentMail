import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LabelList, type Label } from '@/components/sidebar/LabelList';

const labels: Label[] = [
  { id: 'Label_1', name: 'Clients', unreadCount: 3, color: 'blue' },
  { id: 'Label_2', name: 'Invoices', unreadCount: 0, color: 'red' },
];

describe('LabelList', () => {
  it('renders the header and create affordance even at zero labels', () => {
    render(<LabelList activeMailboxId={null} labels={[]} showUnreadCounts onSelect={vi.fn()} />);
    expect(screen.getByText('LABELS')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create label' })).toBeInTheDocument();
    expect(screen.getByText('No labels yet')).toBeInTheDocument();
  });

  it('opens the inline create form and submits it', async () => {
    const user = userEvent.setup();
    const onCreateLabel = vi.fn().mockResolvedValue(undefined);
    render(
      <LabelList
        activeMailboxId={null}
        labels={[]}
        showUnreadCounts
        onSelect={vi.fn()}
        onCreateLabel={onCreateLabel}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Create label' }));
    await user.type(screen.getByPlaceholderText('Label name'), 'Contracts');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() =>
      expect(onCreateLabel).toHaveBeenCalledWith({ name: 'Contracts', colorId: 'black' }),
    );
  });

  it('surfaces a validation error without calling onCreateLabel', async () => {
    const user = userEvent.setup();
    const onCreateLabel = vi.fn();
    render(
      <LabelList
        activeMailboxId={null}
        labels={labels}
        showUnreadCounts
        onSelect={vi.fn()}
        onCreateLabel={onCreateLabel}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Create label' }));
    await user.type(screen.getByPlaceholderText('Label name'), 'clients');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'a label with this name already exists',
    );
    expect(onCreateLabel).not.toHaveBeenCalled();
  });

  it('surfaces a mutation failure visibly', async () => {
    const user = userEvent.setup();
    const onCreateLabel = vi.fn().mockRejectedValue(new Error('Network unavailable'));
    render(
      <LabelList
        activeMailboxId={null}
        labels={[]}
        showUnreadCounts
        onSelect={vi.fn()}
        onCreateLabel={onCreateLabel}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Create label' }));
    await user.type(screen.getByPlaceholderText('Label name'), 'Contracts');
    await user.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network unavailable');
  });

  it('renders every label with its resolved swatch and dispatches onSelect', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <LabelList activeMailboxId="Label_1" labels={labels} showUnreadCounts onSelect={onSelect} />,
    );
    expect(screen.queryByText('No labels yet')).not.toBeInTheDocument();
    const clients = screen.getByText('Clients').closest('button');
    expect(clients).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('3')).toBeInTheDocument();

    const invoices = screen.getByText('Invoices').closest('button');
    await user.click(invoices!);
    expect(onSelect).toHaveBeenCalledWith('Label_2');
  });

  it('hides unread counts when showUnreadCounts is false', () => {
    render(
      <LabelList
        activeMailboxId={null}
        labels={labels}
        showUnreadCounts={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.queryByText('3')).not.toBeInTheDocument();
  });

  it('reveals the delete affordance to keyboard focus, not just hover, and confirms inline', async () => {
    const user = userEvent.setup();
    const onDeleteLabel = vi.fn().mockResolvedValue(undefined);
    render(
      <LabelList
        activeMailboxId={null}
        labels={labels}
        showUnreadCounts
        onSelect={vi.fn()}
        onDeleteLabel={onDeleteLabel}
      />,
    );
    const deleteButton = screen.getByRole('button', { name: 'Delete Clients' });
    // Not hover-dependent: focusing it directly (as Tab would) is enough to
    // interact with it, proving the reveal isn't hover-only.
    deleteButton.focus();
    await user.click(deleteButton);
    expect(screen.getByText("Remove 'Clients'?")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(onDeleteLabel).toHaveBeenCalledWith('Label_1'));
  });

  it('renames a label through the inline form', async () => {
    const user = userEvent.setup();
    const onRenameLabel = vi.fn().mockResolvedValue(undefined);
    render(
      <LabelList
        activeMailboxId={null}
        labels={labels}
        showUnreadCounts
        onSelect={vi.fn()}
        onRenameLabel={onRenameLabel}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit Clients' }));
    const input = screen.getByDisplayValue('Clients');
    await user.clear(input);
    await user.type(input, 'Key Clients');
    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await waitFor(() =>
      expect(onRenameLabel).toHaveBeenCalledWith({ id: 'Label_1', name: 'Key Clients' }),
    );
  });

  it('recolours a label through the colour picker', async () => {
    const user = userEvent.setup();
    const onRecolorLabel = vi.fn().mockResolvedValue(undefined);
    render(
      <LabelList
        activeMailboxId={null}
        labels={labels}
        showUnreadCounts
        onSelect={vi.fn()}
        onRecolorLabel={onRecolorLabel}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit Clients' }));
    await user.click(screen.getByRole('button', { name: "Change Clients's colour" }));
    await user.click(screen.getByRole('gridcell', { name: 'Red' }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() =>
      expect(onRecolorLabel).toHaveBeenCalledWith({ id: 'Label_1', colorId: 'red' }),
    );
  });
});
