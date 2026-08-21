import { normalizeKey, type CommandBindings, type CommandName } from './registry';

export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  const source = navigator.platform || navigator.userAgent || '';
  return /Mac|iPhone|iPad|iPod/.test(source);
}

const MAC_SYMBOLS: Record<string, string> = {
  Meta: '⌘',
  Shift: '⇧',
  Alt: '⌥',
  Control: '⌃',
  Enter: '↵',
  Escape: 'Esc',
  Delete: '⌫',
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

const WINDOWS_LABELS: Record<string, string> = {
  Meta: 'Win',
  Shift: 'Shift',
  Alt: 'Alt',
  Control: 'Ctrl',
  Enter: 'Enter',
  Escape: 'Esc',
  Delete: 'Del',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
};

export function formatBindingParts(binding: string, isMac: boolean = isMacPlatform()): string[] {
  const labels = isMac ? MAC_SYMBOLS : WINDOWS_LABELS;
  return binding
    .split('+')
    .map((part) => labels[part] ?? (part.length === 1 ? part.toUpperCase() : part));
}

function isMacOnly(binding: string): boolean {
  return binding === 'Meta' || binding.startsWith('Meta+');
}

function isWindowsOnly(binding: string): boolean {
  return binding === 'Control' || binding.startsWith('Control+');
}

export function isBindingReachable(binding: string, isMac: boolean = isMacPlatform()): boolean {
  if (isMacOnly(binding)) return isMac;
  if (isWindowsOnly(binding)) return !isMac;
  return true;
}

export function reachableBindings(bindings: string[], isMac: boolean = isMacPlatform()): string[] {
  return bindings.filter((binding) => isBindingReachable(binding, isMac));
}

export function primaryBinding(
  bindings: string[],
  isMac: boolean = isMacPlatform(),
): string | null {
  return reachableBindings(bindings, isMac)[0] ?? null;
}

export function expandUnmodifiedOverride(key: string): string[] {
  if (key.length === 1 && /[a-zA-Z]/.test(key)) {
    return [...new Set([key.toLowerCase(), key.toUpperCase()])];
  }
  return [key];
}

export function captureBinding(
  event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'shiftKey'>,
): string[] {
  const modifier = event.metaKey ? 'Meta' : event.ctrlKey ? 'Control' : '';
  if (!modifier) return expandUnmodifiedOverride(event.key);
  const key = normalizeKey(event.key);
  return [`${modifier}${event.shiftKey ? '+Shift' : ''}+${key}`];
}

export function findConflictingCommand(
  bindings: CommandBindings,
  command: CommandName,
  candidate: string,
  isMac: boolean = isMacPlatform(),
): CommandName | null {
  if (!isBindingReachable(candidate, isMac)) return null;
  const entries = Object.entries(bindings) as [CommandName, string[]][];
  const conflict = entries.find(
    ([otherCommand, otherBindings]) =>
      otherCommand !== command && reachableBindings(otherBindings, isMac).includes(candidate),
  );
  return conflict?.[0] ?? null;
}
