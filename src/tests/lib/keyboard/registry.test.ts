import { describe, expect, it } from 'vitest';
import {
  COMMAND_METADATA,
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
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'J', ctrlKey: true, shiftKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('markNotSpam');
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'J', shiftKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('markSpam');
  });

  it('resolves a real lowercase Meta/Control-a keydown (as browsers actually report it) to selectAll', () => {
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'a', metaKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('selectAll');
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('selectAll');
  });

  it('resolves the compose commands, keeping bare "a" (Reply All) distinct from Meta/Control-A (Select All)', () => {
    expect(commandForKey('c', DEFAULT_COMMAND_BINDINGS)).toBe('newMessage');
    expect(commandForKey('r', DEFAULT_COMMAND_BINDINGS)).toBe('replyToMessage');
    expect(commandForKey('a', DEFAULT_COMMAND_BINDINGS)).toBe('replyAllToMessage');
    expect(commandForKey('f', DEFAULT_COMMAND_BINDINGS)).toBe('forwardMessage');
    expect(
      commandForEvent(new KeyboardEvent('keydown', { key: 'a' }), DEFAULT_COMMAND_BINDINGS),
    ).toBe('replyAllToMessage');
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'a', metaKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('selectAll');
  });

  it('ignores a bare-key binding when a modifier the binding does not name is held', () => {
    for (const init of [
      { key: 'c', ctrlKey: true },
      { key: 'c', metaKey: true },
      { key: 'c', altKey: true },
      { key: 'j', ctrlKey: true },
      { key: 'r', metaKey: true },
      { key: '/', ctrlKey: true },
      { key: 'J', shiftKey: true, altKey: true },
    ]) {
      expect(
        commandForEvent(new KeyboardEvent('keydown', init), DEFAULT_COMMAND_BINDINGS),
      ).toBeNull();
    }
  });

  it('still resolves the shifted uppercase bindings that carry no Shift prefix', () => {
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'I', shiftKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('markRead');
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'U', shiftKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('markUnread');
  });

  it('registers editDraft with no default binding, so it is reachable only programmatically until remapped', () => {
    expect(DEFAULT_COMMAND_BINDINGS.editDraft).toEqual([]);
  });

  it('resolves Cmd/Ctrl-F and the bare slash to focusSearch', () => {
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'f', metaKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('focusSearch');
    expect(
      commandForEvent(
        new KeyboardEvent('keydown', { key: 'f', ctrlKey: true }),
        DEFAULT_COMMAND_BINDINGS,
      ),
    ).toBe('focusSearch');
    expect(commandForKey('/', DEFAULT_COMMAND_BINDINGS)).toBe('focusSearch');
  });

  it('carries a display label and description for every registered command', () => {
    for (const command of Object.keys(
      DEFAULT_COMMAND_BINDINGS,
    ) as (keyof typeof DEFAULT_COMMAND_BINDINGS)[]) {
      expect(COMMAND_METADATA[command].label.length).toBeGreaterThan(0);
      expect(COMMAND_METADATA[command].description.length).toBeGreaterThan(0);
    }
  });
});
