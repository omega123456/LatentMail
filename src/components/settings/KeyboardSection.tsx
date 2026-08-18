import { useState } from 'react';
import {
  useClearAllCommandOverrides,
  useClearCommandOverride,
  useCommandBindings,
  useCommandOverrides,
  useSetCommandOverride,
  useHasAnyCommandOverride,
} from '@/providers/CommandProvider';
import { DEFAULT_COMMAND_BINDINGS, type CommandName } from '@/lib/keyboard/registry';
import { ShortcutRow } from './ShortcutRow';
import { SettingsSection } from './SettingsSection';
import { settingsQuietButton } from './styles';

const COMMAND_ORDER = Object.keys(DEFAULT_COMMAND_BINDINGS) as CommandName[];

export function KeyboardSection() {
  const bindings = useCommandBindings();
  const overrides = useCommandOverrides();
  const setOverride = useSetCommandOverride();
  const clearOverride = useClearCommandOverride();
  const clearAllOverrides = useClearAllCommandOverrides();
  const hasAnyOverride = useHasAnyCommandOverride();
  const [capturingCommand, setCapturingCommand] = useState<CommandName | null>(null);

  const applyCapture = (command: CommandName, keys: string[]) => {
    setOverride(command, keys);
    setCapturingCommand(null);
  };

  return (
    <SettingsSection
      title="Keyboard"
      description="Click a shortcut to change it."
      actions={
        hasAnyOverride ? (
          <button type="button" onClick={clearAllOverrides} className={settingsQuietButton}>
            Reset all
          </button>
        ) : undefined
      }
    >
      <div className="flex flex-col">
        {COMMAND_ORDER.map((command) => (
          <ShortcutRow
            key={command}
            command={command}
            bindings={bindings}
            isOverridden={command in overrides}
            isCapturing={capturingCommand === command}
            onStartCapture={setCapturingCommand}
            onApply={applyCapture}
            onCancelCapture={() => setCapturingCommand(null)}
            onReset={clearOverride}
          />
        ))}
      </div>
    </SettingsSection>
  );
}
