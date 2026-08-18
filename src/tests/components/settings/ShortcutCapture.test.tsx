import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutCapture } from '@/components/settings/ShortcutCapture';
import { DEFAULT_COMMAND_BINDINGS } from '@/lib/keyboard/registry';

describe('ShortcutCapture', () => {
  it('records the next combination and commits it on Apply', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <ShortcutCapture
        command="toggleStar"
        bindings={DEFAULT_COMMAND_BINDINGS}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    const field = screen.getByRole('textbox');
    field.focus();
    await user.keyboard('{Control>}k{/Control}');

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).toHaveBeenCalledWith('toggleStar', ['Control+K']);
  });

  it('abandons on Escape without applying', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onApply = vi.fn();
    render(
      <ShortcutCapture
        command="toggleStar"
        bindings={DEFAULT_COMMAND_BINDINGS}
        onApply={onApply}
        onCancel={onCancel}
      />,
    );

    screen.getByRole('textbox').focus();
    await user.keyboard('{Escape}');

    expect(onCancel).toHaveBeenCalled();
    expect(onApply).not.toHaveBeenCalled();
  });

  it('abandons on blur', async () => {
    const onCancel = vi.fn();
    render(
      <div>
        <ShortcutCapture
          command="toggleStar"
          bindings={DEFAULT_COMMAND_BINDINGS}
          onApply={vi.fn()}
          onCancel={onCancel}
        />
        <button>elsewhere</button>
      </div>,
    );

    const user = userEvent.setup();
    screen.getByRole('textbox').focus();
    await user.click(screen.getByRole('button', { name: 'elsewhere' }));

    expect(onCancel).toHaveBeenCalled();
  });

  it('shows an inline conflict warning naming the other command and disables Apply', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <ShortcutCapture
        command="newMessage"
        bindings={DEFAULT_COMMAND_BINDINGS}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );

    screen.getByRole('textbox').focus();
    await user.keyboard('r');

    expect(screen.getByRole('alert')).toHaveTextContent('Already used by Reply');
    expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onApply).not.toHaveBeenCalled();
  });
});
