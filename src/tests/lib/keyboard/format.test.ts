import { describe, expect, it } from 'vitest';
import { DEFAULT_COMMAND_BINDINGS } from '@/lib/keyboard/registry';
import {
  captureBinding,
  expandUnmodifiedOverride,
  findConflictingCommand,
  formatBindingParts,
  isBindingReachable,
  primaryBinding,
  reachableBindings,
} from '@/lib/keyboard/format';

describe('keyboard binding formatting', () => {
  it('formats a modified combination with Mac symbols', () => {
    expect(formatBindingParts('Meta+Shift+A', true)).toEqual(['⌘', '⇧', 'A']);
  });

  it('formats the same combination with Windows-style text', () => {
    expect(formatBindingParts('Control+Shift+A', false)).toEqual(['Ctrl', 'Shift', 'A']);
  });

  it('uppercases a bare single-character key', () => {
    expect(formatBindingParts('a', true)).toEqual(['A']);
  });
});

describe('platform reachability', () => {
  it('treats a Meta-form binding as mac-only and a Control-form binding as windows-only', () => {
    expect(isBindingReachable('Meta+A', true)).toBe(true);
    expect(isBindingReachable('Meta+A', false)).toBe(false);
    expect(isBindingReachable('Control+A', true)).toBe(false);
    expect(isBindingReachable('Control+A', false)).toBe(true);
  });

  it('treats an unmodified key as reachable on every platform', () => {
    expect(isBindingReachable('a', true)).toBe(true);
    expect(isBindingReachable('a', false)).toBe(true);
  });

  it('picks the platform-reachable binding as primary, ignoring the unreachable alias', () => {
    expect(primaryBinding(DEFAULT_COMMAND_BINDINGS.selectAll, true)).toBe('Meta+A');
    expect(primaryBinding(DEFAULT_COMMAND_BINDINGS.selectAll, false)).toBe('Control+A');
    expect(primaryBinding(DEFAULT_COMMAND_BINDINGS.moveCursorDown)).toBe('ArrowDown');
    expect(primaryBinding(DEFAULT_COMMAND_BINDINGS.moveCursorUp)).toBe('ArrowUp');
  });

  it('filters a binding list down to what the platform can produce', () => {
    expect(reachableBindings(DEFAULT_COMMAND_BINDINGS.focusSearch, true)).toEqual(['Meta+F', '/']);
    expect(reachableBindings(DEFAULT_COMMAND_BINDINGS.focusSearch, false)).toEqual([
      'Control+F',
      '/',
    ]);
  });

  it('reports "not set" as no reachable binding for a command with none', () => {
    expect(primaryBinding(DEFAULT_COMMAND_BINDINGS.editDraft, true)).toBeNull();
  });
});

describe('capturing a key combination', () => {
  it('registers both cases for an unmodified single character, so rebinding to one does not break the other', () => {
    expect(expandUnmodifiedOverride('a')).toEqual(['a', 'A']);
    expect(expandUnmodifiedOverride('A')).toEqual(['a', 'A']);
  });

  it('leaves a non-letter unmodified key as a single value', () => {
    expect(expandUnmodifiedOverride('Escape')).toEqual(['Escape']);
  });

  it('captures a modified combination with the modifier-plus-uppercased-key encoding', () => {
    expect(captureBinding({ key: 'k', metaKey: true, ctrlKey: false, shiftKey: false })).toEqual([
      'Meta+K',
    ]);
    expect(captureBinding({ key: 'k', metaKey: false, ctrlKey: true, shiftKey: true })).toEqual([
      'Control+Shift+K',
    ]);
  });

  it('captures an unmodified key by expanding both cases', () => {
    expect(captureBinding({ key: 'n', metaKey: false, ctrlKey: false, shiftKey: false })).toEqual([
      'n',
      'N',
    ]);
  });
});

describe('conflict detection', () => {
  it('names the other command that already owns a candidate binding', () => {
    expect(findConflictingCommand(DEFAULT_COMMAND_BINDINGS, 'newMessage', 'r', true)).toBe(
      'replyToMessage',
    );
  });

  it('reports no conflict for a binding nobody owns', () => {
    expect(
      findConflictingCommand(DEFAULT_COMMAND_BINDINGS, 'newMessage', 'Meta+Shift+Z', true),
    ).toBeNull();
  });

  it('ignores a collision against a binding the host platform can never produce', () => {
    const bindings = {
      ...DEFAULT_COMMAND_BINDINGS,
      newMessage: ['Control+K'],
    };
    expect(findConflictingCommand(bindings, 'toggleStar', 'Control+K', true)).toBeNull();
    expect(findConflictingCommand(bindings, 'toggleStar', 'Control+K', false)).toBe('newMessage');
  });
});
