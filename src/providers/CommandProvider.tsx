import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
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

function adoptHydratedOverrides(
  hydrated: CommandOverrides,
  current: CommandOverrides,
): CommandOverrides {
  const merged = { ...hydrated, ...current };
  const changedBeforeHydration = Object.keys(current).length > 0;
  if (changedBeforeHydration) persistOverrides(merged);
  return merged;
}

export function CommandProvider({ children }: PropsWithChildren) {
  const [overrides, setOverrides] = useState<CommandOverrides>({});
  const latestOverrides = useRef<CommandOverrides>({});

  const replaceOverrides = useCallback((next: CommandOverrides) => {
    latestOverrides.current = next;
    setOverrides(next);
  }, []);

  const changeOverrides = useCallback(
    (change: (current: CommandOverrides) => CommandOverrides) => {
      const next = change(latestOverrides.current);
      persistOverrides(next);
      replaceOverrides(next);
    },
    [replaceOverrides],
  );

  useEffect(() => {
    hydrateSettings()
      .then((settings) =>
        replaceOverrides(
          adoptHydratedOverrides(settings.commandOverrides ?? {}, latestOverrides.current),
        ),
      )
      .catch(() => undefined);
  }, [replaceOverrides]);

  const contextValue = useMemo<CommandContextValue>(
    () => ({
      bindings: resolveCommandBindings(overrides),
      overrides: overrides,
      setOverride: (command, keys) =>
        changeOverrides((current) => ({ ...current, [command]: keys })),
      clearOverride: (command) => changeOverrides((current) => withoutOverride(current, command)),
      clearAllOverrides: () => changeOverrides(() => ({})),
      hasAnyOverride: Object.keys(overrides).length > 0,
    }),
    [overrides, changeOverrides],
  );

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
