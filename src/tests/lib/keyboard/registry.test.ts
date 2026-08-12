import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMMAND_BINDINGS,
  commandForKey,
  commandForEvent,
  resolveCommandBindings,
} from '@/lib/keyboard/registry';

describe('keyboard command registry', () => {
  it('resolves the defaults with no overrides supplied', () => {
    expect(resolveCommandBindings()).toEqual(DEFAULT_COMMAND_BINDINGS);
  });

  it('lets a supplied override replace a default key list entirely', () => {
    const bindings = resolveCommandBindings({ moveCursorDown: ['n'] });
    expect(bindings.moveCursorDown).toEqual(['n']);
    // Untouched commands keep their defaults.
    expect(bindings.moveCursorUp).toEqual(DEFAULT_COMMAND_BINDINGS.moveCursorUp);
  });

  it('finds the command bound to a key', () => {
    expect(commandForKey('j', DEFAULT_COMMAND_BINDINGS)).toBe('moveCursorDown');
    expect(commandForKey('Escape', DEFAULT_COMMAND_BINDINGS)).toBe('dismiss');
  });

  it('returns null for an unbound key', () => {
    expect(commandForKey('x', DEFAULT_COMMAND_BINDINGS)).toBeNull();
  });

  it('keeps Cmd/Ctrl-Shift-J distinct from the spam shortcut', () => {
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'J', ctrlKey: true, shiftKey: true }), DEFAULT_COMMAND_BINDINGS)).toBe('markNotSpam');
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'J', shiftKey: true }), DEFAULT_COMMAND_BINDINGS)).toBe('markSpam');
  });

  it('resolves a real lowercase Meta/Control-a keydown (as browsers actually report it) to selectAll', () => {
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true }), DEFAULT_COMMAND_BINDINGS)).toBe('selectAll');
    expect(commandForEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }), DEFAULT_COMMAND_BINDINGS)).toBe('selectAll');
  });
});
