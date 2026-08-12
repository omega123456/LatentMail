import { useEffect } from 'react';
import { useCommandBindings } from '@/providers/CommandProvider';
import { commandForEvent, type CommandName } from './registry';

type CommandHandlers = Partial<Record<CommandName, (event: KeyboardEvent) => void>>;

/** True while a text input, contenteditable region, or an open menu/dialog
 * holds keyboard focus — commands must not fire underneath one (e.g. typing
 * "j" into a future search box, or "Escape" closing a menu, shouldn't also
 * move the conversation cursor). Reused by Phase 8 for action shortcuts. */
export function hasFocusContext(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable)
    return true;
  return (
    active.closest('[role="menu"], [role="dialog"], [role="listbox"], [role="menuitem"]') != null
  );
}

/** Dispatches registered keyboard commands to `handlers`, resolved against
 * the current `CommandProvider` bindings, while ignoring keydowns that occur
 * with a text input, menu, or dialog focused. */
export function useCommands(handlers: CommandHandlers): void {
  const bindings = useCommandBindings();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (hasFocusContext()) return;
      const command = commandForEvent(event, bindings);
      if (!command) return;
      const handler = handlers[command];
      if (!handler) return;
      handler(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [bindings, handlers]);
}
