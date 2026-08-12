import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CommandProvider, useSetCommandOverride } from '@/providers/CommandProvider';
import { hasFocusContext, useCommands } from '@/lib/keyboard/useCommands';

function Probe({ onDismiss }: { onDismiss: () => void }) {
  useCommands({ dismiss: onDismiss });
  return <input aria-label="probe input" />;
}

function RemapButton() {
  const setOverride = useSetCommandOverride();
  return <button onClick={() => setOverride('dismiss', ['x'])}>Remap dismiss to x</button>;
}

describe('useCommands', () => {
  it('dispatches a registered command for its default key', () => {
    const onDismiss = vi.fn();
    render(<Probe onDismiss={onDismiss} />);

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it('ignores an unregistered key', () => {
    const onDismiss = vi.fn();
    render(<Probe onDismiss={onDismiss} />);

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z' })));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not fire while a text input holds focus', () => {
    const onDismiss = vi.fn();
    render(<Probe onDismiss={onDismiss} />);
    screen.getByLabelText('probe input').focus();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not fire while a menu holds focus', () => {
    const onDismiss = vi.fn();
    render(
      <>
        <Probe onDismiss={onDismiss} />
        <div role="menu">
          <button role="menuitem">Item</button>
        </div>
      </>,
    );
    screen.getByRole('menuitem').focus();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));

    expect(onDismiss).not.toHaveBeenCalled();
    expect(hasFocusContext()).toBe(true);
  });

  it('resolves a CommandProvider override over the default binding', () => {
    const onDismiss = vi.fn();
    render(
      <CommandProvider>
        <RemapButton />
        <Probe onDismiss={onDismiss} />
      </CommandProvider>,
    );

    act(() => screen.getByText('Remap dismiss to x').click());
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })));
    expect(onDismiss).not.toHaveBeenCalled();

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x' })));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
