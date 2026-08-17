import { useEffect } from 'react';
import { useCommandBindings } from '@/providers/CommandProvider';
import { commandForEvent, type CommandName } from './registry';

type CommandHandlers = Partial<Record<CommandName, (event: KeyboardEvent) => void>>;

export function hasFocusContext(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (!active) return false;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(active.tagName) || active.isContentEditable)
    return true;
  return (
    active.closest('[role="menu"], [role="dialog"], [role="listbox"], [role="menuitem"]') != null
  );
}

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
