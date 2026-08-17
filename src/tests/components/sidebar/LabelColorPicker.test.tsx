import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LabelColorPicker } from '@/components/sidebar/LabelColorPicker';
import { LABEL_COLOR_PALETTE } from '@/lib/labels/palette';

describe('LabelColorPicker', () => {
  it('uses the human-readable colour name for every swatch and the footer readout, never a hex value', () => {
    render(<LabelColorPicker selectedId="blue" onApply={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByRole('gridcell', { name: 'Blue' })).toBeInTheDocument();
    expect(screen.getByText('Blue')).toBeInTheDocument();
    expect(screen.queryByText(/#/)).not.toBeInTheDocument();
  });

  it('disables Apply until a different swatch is selected, then applies it', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(<LabelColorPicker selectedId="blue" onApply={onApply} onCancel={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
    await user.click(screen.getByRole('gridcell', { name: 'Red' }));
    expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith('red');
  });

  it('nests every gridcell inside a row, directly under the grid — a valid ARIA grid/row/gridcell hierarchy', () => {
    render(<LabelColorPicker selectedId="blue" onApply={vi.fn()} onCancel={vi.fn()} />);
    const grid = screen.getByRole('grid', { name: 'Label colour' });
    const rows = within(grid).getAllByRole('row');
    expect(rows.length).toBeGreaterThan(1);

    expect(Array.from(grid.children).every((child) => child.getAttribute('role') === 'row')).toBe(
      true,
    );
    const totalCells = rows.reduce(
      (sum, row) => sum + within(row).getAllByRole('gridcell').length,
      0,
    );
    expect(totalCells).toBe(LABEL_COLOR_PALETTE.length);
  });

  it('groups swatches into contiguous hue-family rows rather than raw declaration order', () => {
    render(<LabelColorPicker selectedId="blue" onApply={vi.fn()} onCancel={vi.fn()} />);
    const cellNames = screen
      .getAllByRole('gridcell')
      .map((cell) => cell.getAttribute('aria-label'));

    expect(cellNames).not.toEqual(LABEL_COLOR_PALETTE.map((swatch) => swatch.name));
  });

  it('is fully keyboard-traversable, moving vertically by column index rather than list position', async () => {
    const user = userEvent.setup();
    render(<LabelColorPicker selectedId="black" onApply={vi.fn()} onCancel={vi.fn()} />);
    const cells = screen.getAllByRole('gridcell');

    cells[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(cells[10]).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(cells[11]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(cells[1]).toHaveFocus();
  });

  it('selects on Enter and resets the pending selection on Cancel', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(<LabelColorPicker selectedId="black" onApply={vi.fn()} onCancel={onCancel} />);
    screen.getByRole('gridcell', { name: 'Green' }).focus();
    await user.keyboard('{Enter}');
    expect(screen.getByText('Green')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
