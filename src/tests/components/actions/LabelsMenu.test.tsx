import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LabelsMenu, type LabelMenuEntry } from '@/components/actions/LabelsMenu';

const labels: LabelMenuEntry[] = [
  { id: 'Label_1', name: 'Clients', color: 'blue', membership: 'checked' },
  { id: 'Label_2', name: 'Invoices', color: 'red', membership: 'indeterminate' },
  { id: 'Label_3', name: 'Urgent', color: 'orange', membership: 'unchecked' },
];

describe('LabelsMenu — staged variant', () => {
  it('exposes indeterminate membership as aria-checked="mixed"', () => {
    render(<LabelsMenu variant="staged" labels={labels} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('menuitemcheckbox', { name: /Invoices/ })).toHaveAttribute(
      'aria-checked',
      'mixed',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: /Clients/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: /Urgent/ })).toHaveAttribute(
      'aria-checked',
      'false',
    );
  });

  it('disables Apply until membership differs, then reports the change count', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<LabelsMenu variant="staged" labels={labels} onApply={onApply} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    expect(screen.getByText('0 changes staged')).toBeInTheDocument();

    await user.click(screen.getByRole('menuitemcheckbox', { name: /Urgent/ }));
    expect(screen.getByText('1 change staged')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ add: ['Label_3'], remove: [] });
  });

  it('reports a removal when an already-checked label is unchecked', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<LabelsMenu variant="staged" labels={labels} onApply={onApply} onCancel={vi.fn()} />);
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Clients/ }));
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith({ add: [], remove: ['Label_1'] });
  });

  it('calls onCancel without applying', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    const onCancel = vi.fn();
    render(<LabelsMenu variant="staged" labels={labels} onApply={onApply} onCancel={onCancel} />);
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('shows the filter only above ten labels', () => {
    const { rerender } = render(
      <LabelsMenu variant="staged" labels={labels} onApply={vi.fn()} onCancel={vi.fn()} />,
    );
    expect(screen.queryByLabelText('Filter labels')).not.toBeInTheDocument();

    const many: LabelMenuEntry[] = Array.from({ length: 11 }, (_, index) => ({
      id: `Label_${index}`,
      name: `Label ${index}`,
      color: 'black',
      membership: 'unchecked',
    }));
    rerender(<LabelsMenu variant="staged" labels={many} onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByLabelText('Filter labels')).toBeInTheDocument();
  });

  it('distinguishes the zero-labels empty state (with a create route) from a no-match filter result', async () => {
    const user = userEvent.setup();
    const onCreateLabel = vi.fn();
    const { rerender } = render(
      <LabelsMenu
        variant="staged"
        labels={[]}
        onApply={vi.fn()}
        onCancel={vi.fn()}
        onCreateLabel={onCreateLabel}
      />,
    );
    expect(screen.getByText('No labels yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Create label' }));
    expect(onCreateLabel).toHaveBeenCalledOnce();

    const many: LabelMenuEntry[] = Array.from({ length: 11 }, (_, index) => ({
      id: `Label_${index}`,
      name: `Label ${index}`,
      color: 'black',
      membership: 'unchecked',
    }));
    rerender(<LabelsMenu variant="staged" labels={many} onApply={vi.fn()} onCancel={vi.fn()} />);
    await user.type(screen.getByLabelText('Filter labels'), 'nonexistent');
    expect(screen.getByText(/No labels match/)).toBeInTheDocument();
  });

  it('moves focus between rows with ArrowDown/ArrowUp and toggles on Enter/Space', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<LabelsMenu variant="staged" labels={labels} onApply={onApply} onCancel={vi.fn()} />);
    const clients = screen.getByRole('menuitemcheckbox', { name: /Clients/ });
    const invoices = screen.getByRole('menuitemcheckbox', { name: /Invoices/ });
    const urgent = screen.getByRole('menuitemcheckbox', { name: /Urgent/ });
    clients.focus();
    await user.keyboard('{ArrowDown}');
    expect(invoices).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(urgent).toHaveFocus();
    await user.keyboard('{ArrowDown}');
    expect(clients).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(urgent).toHaveFocus();
    await user.keyboard(' ');
    expect(screen.getByText('1 change staged')).toBeInTheDocument();
  });
});

describe('LabelsMenu — immediate variant', () => {
  it('commits every toggle immediately and renders no Apply footer', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    render(<LabelsMenu variant="immediate" labels={labels} onToggle={onToggle} />);
    expect(screen.queryByRole('button', { name: 'Apply' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Clients/ }));
    expect(onToggle).toHaveBeenCalledWith('Label_1', false);
    await user.click(screen.getByRole('menuitemcheckbox', { name: /Urgent/ }));
    expect(onToggle).toHaveBeenCalledWith('Label_3', true);
  });
});
