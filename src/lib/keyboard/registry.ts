export type CommandName =
  | 'moveCursorDown'
  | 'moveCursorUp'
  | 'pageCursorDown'
  | 'pageCursorUp'
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
  | 'editDraft'
  | 'focusSearch';

export type CommandBindings = Record<CommandName, string[]>;

export const DEFAULT_COMMAND_BINDINGS: CommandBindings = {
  moveCursorDown: ['ArrowDown', 'j', 'J'],
  moveCursorUp: ['ArrowUp', 'k', 'K'],
  pageCursorDown: ['PageDown'],
  pageCursorUp: ['PageUp'],
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
  focusSearch: ['Meta+F', 'Control+F', '/'],
};

export type CommandOverrides = Partial<CommandBindings>;

export type CommandMetadata = { label: string; description: string };

export const COMMAND_METADATA: Record<CommandName, CommandMetadata> = {
  moveCursorDown: { label: 'Move down', description: 'Move the cursor to the next conversation.' },
  moveCursorUp: { label: 'Move up', description: 'Move the cursor to the previous conversation.' },
  pageCursorDown: {
    label: 'Page down',
    description: 'Move the cursor down by one screen of conversations.',
  },
  pageCursorUp: {
    label: 'Page up',
    description: 'Move the cursor up by one screen of conversations.',
  },
  openConversation: { label: 'Open', description: 'Open the conversation under the cursor.' },
  dismiss: { label: 'Dismiss', description: 'Close the open conversation or dialog.' },
  selectAll: { label: 'Select all', description: 'Select every conversation in the list.' },
  toggleStar: { label: 'Toggle star', description: 'Star or unstar the selected conversation.' },
  markRead: { label: 'Mark as read', description: 'Mark the selected conversation as read.' },
  markUnread: { label: 'Mark as unread', description: 'Mark the selected conversation as unread.' },
  markSpam: { label: 'Mark as spam', description: 'Report the selected conversation as spam.' },
  markNotSpam: {
    label: 'Not spam',
    description: 'Move the selected conversation out of Spam.',
  },
  deleteConversation: { label: 'Delete', description: 'Move the selected conversation to Trash.' },
  newMessage: { label: 'Compose', description: 'Start a new message.' },
  replyToMessage: { label: 'Reply', description: 'Reply to the sender of this message.' },
  replyAllToMessage: { label: 'Reply all', description: 'Reply to everyone on the thread.' },
  forwardMessage: { label: 'Forward', description: 'Forward the selected message.' },
  editDraft: { label: 'Edit draft', description: 'Resume editing the selected draft.' },
  focusSearch: { label: 'Search', description: 'Jump to the search field.' },
};

export function resolveCommandBindings(overrides: CommandOverrides = {}): CommandBindings {
  return { ...DEFAULT_COMMAND_BINDINGS, ...overrides };
}

export function commandForKey(key: string, bindings: CommandBindings): CommandName | null {
  const match = (Object.keys(bindings) as CommandName[]).find((name) =>
    bindings[name].includes(key),
  );
  return match ?? null;
}

export function normalizeKey(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

export function commandForEvent(
  event: KeyboardEvent,
  bindings: CommandBindings,
): CommandName | null {
  if (event.altKey) return null;
  const modifier = event.metaKey ? 'Meta' : event.ctrlKey ? 'Control' : '';
  const key = modifier ? normalizeKey(event.key) : event.key;
  const binding = modifier
    ? `${modifier}${event.shiftKey ? '+Shift' : ''}+${key}`
    : event.shiftKey
      ? `Shift+${key}`
      : key;
  const match = commandForKey(binding, bindings);
  if (match) return match;
  return modifier ? null : commandForKey(event.key, bindings);
}
