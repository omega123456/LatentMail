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
  editDraft: [],
};

export type CommandOverrides = Partial<CommandBindings>;

export function resolveCommandBindings(overrides: CommandOverrides = {}): CommandBindings {
  return { ...DEFAULT_COMMAND_BINDINGS, ...overrides };
}

export function commandForKey(key: string, bindings: CommandBindings): CommandName | null {
  const match = (Object.keys(bindings) as CommandName[]).find((name) =>
    bindings[name].includes(key),
  );
  return match ?? null;
}

function normalizeKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

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
