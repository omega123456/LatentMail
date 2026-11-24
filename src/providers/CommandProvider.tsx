import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { invoke } from '@/lib/ipc/commands';
import { hydrateSettings } from '@/lib/settings/hydrate';
import {
  resolveCommandBindings,
  type CommandBindings,
  type CommandName,
  type CommandOverrides,
} from '@/lib/keyboard/registry';

type CommandContextValue = {
  bindings: CommandBindings;
  overrides: CommandOverrides;
  setOverride: (command: CommandName, keys: string[]) => void;
  clearOverride: (command: CommandName) => void;
  clearAllOverrides: () => void;
  hasAnyOverride: boolean;
};

const defaultValue: CommandContextValue = {
  bindings: resolveCommandBindings(),
  overrides: {},
  setOverride: () => undefined,
  clearOverride: () => undefined,
  clearAllOverrides: () => undefined,
  hasAnyOverride: false,
};

const CommandContext = createContext<CommandContextValue>(defaultValue);

function persistOverrides(overrides: CommandOverrides) {
  void invoke('write_setting', { key: 'commandOverrides', value: overrides }).catch(
    () => undefined,
  );
}

function withoutOverride(overrides: CommandOverrides, command: CommandName): CommandOverrides {
  const remaining = { ...overrides };
  delete remaining[command];
  return remaining;
}

export function CommandProvider({ children }: PropsWithChildren) {
  const [overrides, setOverrides] = useState<CommandOverrides>({});

  useEffect(() => {
    hydrateSettings()
      .then((settings) => setOverrides(settings.commandOverrides ?? {}))
      .catch(() => undefined);
  }, []);

  const contextValue = useMemo<CommandContextValue>(() => {
    const applyOverrides = (next: CommandOverrides) => {
      persistOverrides(next);
      setOverrides(next);
    };
    return {
      bindings: resolveCommandBindings(overrides),
      overrides: overrides,
      setOverride: (command, keys) => applyOverrides({ ...overrides, [command]: keys }),
      clearOverride: (command) => applyOverrides(withoutOverride(overrides, command)),
      clearAllOverrides: () => applyOverrides({}),
      hasAnyOverride: Object.keys(overrides).length > 0,
    };
  }, [overrides]);

  return <CommandContext.Provider value={contextValue}>{children}</CommandContext.Provider>;
}

export function useCommandBindings(): CommandBindings {
  return useContext(CommandContext).bindings;
}

export function useCommandOverrides(): CommandOverrides {
  return useContext(CommandContext).overrides;
}

export function useSetCommandOverride(): CommandContextValue['setOverride'] {
  return useContext(CommandContext).setOverride;
}

export function useClearCommandOverride(): CommandContextValue['clearOverride'] {
  return useContext(CommandContext).clearOverride;
}

export function useClearAllCommandOverrides(): CommandContextValue['clearAllOverrides'] {
  return useContext(CommandContext).clearAllOverrides;
}

export function useHasAnyCommandOverride(): boolean {
  return useContext(CommandContext).hasAnyOverride;
}
