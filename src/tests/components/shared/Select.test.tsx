import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select } from '@/components/shared/Select';

const options = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

function ControlledSelect({ onChange }: { onChange?: (value: string) => void }) {
  const [value, setValue] = useState('banana');
  return (
    <Select
      id="fruit"
      ariaLabel="Fruit"
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      options={options}
      className="rounded"
    />
  );
}

describe('Select', () => {
  it('shows the selected label on the trigger and marks it selected when open', async () => {
    const user = userEvent.setup();
    render(<ControlledSelect />);

    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    expect(trigger).toHaveTextContent('Banana');

    await user.click(trigger);

    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveAttribute('aria-selected', 'false');
  });

  it('commits the highlighted option with the keyboard', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSelect onChange={onChange} />);

    screen.getByRole('combobox', { name: 'Fruit' }).focus();
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledWith('cherry');
    expect(screen.getByRole('combobox', { name: 'Fruit' })).toHaveTextContent('Cherry');
  });

  it('closes on Escape without changing the value', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSelect onChange={onChange} />);

    const trigger = screen.getByRole('combobox', { name: 'Fruit' });
    await user.click(trigger);
    await user.keyboard('{ArrowDown}{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    expect(trigger).toHaveTextContent('Banana');
  });

  it('jumps to a matching option by typeahead', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<ControlledSelect onChange={onChange} />);

    await user.click(screen.getByRole('combobox', { name: 'Fruit' }));
    await user.keyboard('a{Enter}');

    expect(onChange).toHaveBeenCalledWith('apple');
  });
});
