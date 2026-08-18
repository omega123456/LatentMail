import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react';
import { invoke } from '@/lib/ipc/commands';
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

export function CommandProvider({ children }: PropsWithChildren) {
  const [overrides, setOverrides] = useState<CommandOverrides>({});

  useEffect(() => {
    invoke('read_settings', {})
      .then((settings) => setOverrides(settings.commandOverrides ?? {}))
      .catch(() => undefined);
  }, []);

  const value = useMemo<CommandContextValue>(
    () => ({
      bindings: resolveCommandBindings(overrides),
      overrides,
      setOverride: (command, keys) =>
        setOverrides((current) => {
          const next = { ...current, [command]: keys };
          persistOverrides(next);
          return next;
        }),
      clearOverride: (command) =>
        setOverrides((current) => {
          const next = { ...current };
          delete next[command];
          persistOverrides(next);
          return next;
        }),
      clearAllOverrides: () => {
        persistOverrides({});
        setOverrides({});
      },
      hasAnyOverride: Object.keys(overrides).length > 0,
    }),
    [overrides],
  );

  return <CommandContext.Provider value={value}>{children}</CommandContext.Provider>;
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
