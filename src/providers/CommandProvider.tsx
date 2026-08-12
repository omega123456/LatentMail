import { createContext, useContext, useMemo, useState, type PropsWithChildren } from 'react';
import {
  resolveCommandBindings,
  type CommandBindings,
  type CommandName,
  type CommandOverrides,
} from '@/lib/keyboard/registry';

type CommandContextValue = {
  bindings: CommandBindings;
  setOverride: (command: CommandName, keys: string[]) => void;
};

// A sensible default so `useCommands`/`useCommandBindings` still work for
// components rendered without a `CommandProvider` ancestor (existing unit
// tests render `ConversationList` bare) — it just can't be remapped.
const defaultValue: CommandContextValue = {
  bindings: resolveCommandBindings(),
  setOverride: () => undefined,
};

const CommandContext = createContext<CommandContextValue>(defaultValue);

/** Mounts the keyboard-command registry, holding any per-command key
 * overrides in state so a future remap UI can call `useSetCommandOverride`.
 * Follows the existing provider convention: no visible DOM, just context +
 * a paired hook. */
export function CommandProvider({ children }: PropsWithChildren) {
  const [overrides, setOverrides] = useState<CommandOverrides>({});
  const value = useMemo<CommandContextValue>(
    () => ({
      bindings: resolveCommandBindings(overrides),
      setOverride: (command, keys) => setOverrides((current) => ({ ...current, [command]: keys })),
    }),
    [overrides],
  );

  return <CommandContext.Provider value={value}>{children}</CommandContext.Provider>;
}

export function useCommandBindings(): CommandBindings {
  return useContext(CommandContext).bindings;
}

export function useSetCommandOverride(): CommandContextValue['setOverride'] {
  return useContext(CommandContext).setOverride;
}
