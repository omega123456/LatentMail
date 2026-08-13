/**
 * Named keyboard-command registry.
 *
 * Every keyboard shortcut in the app is a named command with a default key
 * list, resolvable against an optional override map (a supplied override
 * entirely replaces the default key list for that command — future phases'
 * remap UI writes here). Only conversation-list navigation is registered in
 * this phase; Phase 8 adds action commands (delete/star/etc) to this same
 * shape.
 */

export type CommandName =
  | 'moveCursorDown'
  | 'moveCursorUp'
  | 'openConversation'
  | 'dismiss'
  | 'selectAll'
  | 'toggleStar'
  | 'markRead'
  | 'markUnread'
  | 'markSpam'
  | 'markNotSpam'
  | 'deleteConversation'
  | 'newMessage'
  | 'replyToMessage'
  | 'replyAllToMessage'
  | 'forwardMessage'
  | 'editDraft';

export type CommandBindings = Record<CommandName, string[]>;

export const DEFAULT_COMMAND_BINDINGS: CommandBindings = {
  moveCursorDown: ['j', 'J', 'ArrowDown'],
  moveCursorUp: ['k', 'K', 'ArrowUp'],
  openConversation: ['Enter', 'o', 'O'],
  dismiss: ['Escape'],
  selectAll: ['Meta+A', 'Control+A'],
  toggleStar: ['s', 'S'],
  markRead: ['I'],
  markUnread: ['U'],
  markSpam: ['Shift+J'],
  markNotSpam: ['Meta+Shift+J', 'Control+Shift+J'],
  deleteConversation: ['Delete'],
  newMessage: ['c', 'C'],
  replyToMessage: ['r', 'R'],
  replyAllToMessage: ['a', 'A'],
  forwardMessage: ['f', 'F'],
  // No default key: Edit Draft has no established convention to collide
  // with or follow, so it starts keyboard-inaccessible until a future
  // remap UI (or product decision) assigns one. Still a named registry
  // command — every compose call site resolves through it rather than
  // hard-coding a key, even the ones without a default binding yet.
  editDraft: [],
};

export type CommandOverrides = Partial<CommandBindings>;

/** Merges a supplied override map over the defaults. An override for a
 * command entirely replaces its default key list rather than merging with
 * it, so remapping "J" away from `moveCursorDown` doesn't require also
 * re-declaring `ArrowDown`. */
export function resolveCommandBindings(overrides: CommandOverrides = {}): CommandBindings {
  return { ...DEFAULT_COMMAND_BINDINGS, ...overrides };
}

/** Finds the command bound to `key` under `bindings`, or `null` if no
 * registered command claims that key. */
export function commandForKey(key: string, bindings: CommandBindings): CommandName | null {
  const match = (Object.keys(bindings) as CommandName[]).find((name) =>
    bindings[name].includes(key),
  );
  return match ?? null;
}

/** Single-character keys (letters) report lowercase from a real `keydown`
 * event when combined with Meta/Control, unlike Shift, which the OS already
 * uppercases at the browser level. Declared bindings always spell the
 * single-character portion uppercase (e.g. `Meta+A`), so normalize here to
 * match regardless of which modifier produced the event. */
function normalizeKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/** Resolves modified bindings before plain keys, so Cmd/Ctrl-Shift-J can
 * never be mistaken for the plain Shift-J spam shortcut. Only the
 * Meta/Control-modified lookup normalizes case — Shift already uppercases
 * `event.key` at the browser level, and the plain (unmodified) fallback
 * must stay literal so remapped/custom single-key bindings (e.g. a
 * lowercase-only override) still match exactly what was declared. */
export function commandForEvent(
  event: KeyboardEvent,
  bindings: CommandBindings,
): CommandName | null {
  const modifier = event.metaKey ? 'Meta' : event.ctrlKey ? 'Control' : '';
  const key = modifier ? normalizeKey(event.key) : event.key;
  const binding = modifier
    ? `${modifier}${event.shiftKey ? '+Shift' : ''}+${key}`
    : event.shiftKey
      ? `Shift+${key}`
      : key;
  return commandForKey(binding, bindings) ?? commandForKey(event.key, bindings);
}
