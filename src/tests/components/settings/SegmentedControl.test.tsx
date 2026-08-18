import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { SegmentedControl } from '@/components/settings/SegmentedControl';

describe('SegmentedControl', () => {
  it('marks the selected option and calls onChange when another is picked', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <SegmentedControl
        ariaLabel="Theme"
        value="system"
        onChange={onChange}
        options={[
          { value: 'light', label: 'Light' },
          { value: 'dark', label: 'Dark' },
          { value: 'system', label: 'System' },
        ]}
      />,
    );

    const group = screen.getByRole('radiogroup', { name: 'Theme' });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'false');

    await user.click(screen.getByRole('radio', { name: 'Dark' }));
    expect(onChange).toHaveBeenCalledWith('dark');
  });

  it('renders an optional glyph per segment', () => {
    render(
      <SegmentedControl
        ariaLabel="Mail layout"
        value="three-column"
        onChange={() => undefined}
        options={[
          { value: 'three-column', label: 'Three-column', glyph: <span data-testid="glyph" /> },
        ]}
      />,
    );

    expect(screen.getByTestId('glyph')).toBeInTheDocument();
  });
});
