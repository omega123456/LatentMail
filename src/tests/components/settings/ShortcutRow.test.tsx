import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ShortcutRow } from '@/components/settings/ShortcutRow';
import { DEFAULT_COMMAND_BINDINGS } from '@/lib/keyboard/registry';

describe('ShortcutRow', () => {
  it('shows label, description and keycaps, with no Custom badge or Reset by default', () => {
    render(
      <ShortcutRow
        command="replyAllToMessage"
        bindings={DEFAULT_COMMAND_BINDINGS}
        isOverridden={false}
        isCapturing={false}
        onStartCapture={vi.fn()}
        onApply={vi.fn()}
        onCancelCapture={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByText('Reply all')).toBeInTheDocument();
    expect(screen.getByText('Reply to everyone on the thread.')).toBeInTheDocument();
    expect(screen.queryByText('Custom')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });

  it('shows a Custom badge and Reset only when overridden', async () => {
    const user = userEvent.setup();
    const onReset = vi.fn();
    render(
      <ShortcutRow
        command="replyAllToMessage"
        bindings={{ ...DEFAULT_COMMAND_BINDINGS, replyAllToMessage: ['Shift+A'] }}
        isOverridden
        isCapturing={false}
        onStartCapture={vi.fn()}
        onApply={vi.fn()}
        onCancelCapture={vi.fn()}
        onReset={onReset}
      />,
    );

    expect(screen.getByText('Custom')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onReset).toHaveBeenCalledWith('replyAllToMessage');
  });

  it('starts capture from the keycaps control', async () => {
    const user = userEvent.setup();
    const onStartCapture = vi.fn();
    render(
      <ShortcutRow
        command="replyAllToMessage"
        bindings={DEFAULT_COMMAND_BINDINGS}
        isOverridden={false}
        isCapturing={false}
        onStartCapture={onStartCapture}
        onApply={vi.fn()}
        onCancelCapture={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Change shortcut for Reply all' }));
    expect(onStartCapture).toHaveBeenCalledWith('replyAllToMessage');
  });

  it('replaces the keycaps with the capture field while capturing', () => {
    render(
      <ShortcutRow
        command="replyAllToMessage"
        bindings={DEFAULT_COMMAND_BINDINGS}
        isOverridden={false}
        isCapturing
        onStartCapture={vi.fn()}
        onApply={vi.fn()}
        onCancelCapture={vi.fn()}
        onReset={vi.fn()}
      />,
    );

    expect(screen.getByRole('textbox')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Change shortcut for Reply all' }),
    ).not.toBeInTheDocument();
  });
});
