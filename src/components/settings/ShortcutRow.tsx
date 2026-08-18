import { COMMAND_METADATA, type CommandBindings, type CommandName } from '@/lib/keyboard/registry';
import { KeyCaps } from './KeyCaps';
import { ShortcutCapture } from './ShortcutCapture';
import { settingsLinkPrimary } from './styles';

export function ShortcutRow({
  command,
  bindings,
  isOverridden,
  isCapturing,
  onStartCapture,
  onApply,
  onCancelCapture,
  onReset,
}: {
  command: CommandName;
  bindings: CommandBindings;
  isOverridden: boolean;
  isCapturing: boolean;
  onStartCapture: (command: CommandName) => void;
  onApply: (command: CommandName, keys: string[]) => void;
  onCancelCapture: () => void;
  onReset: (command: CommandName) => void;
}) {
  const metadata = COMMAND_METADATA[command];
  return (
    <div
      data-testid={`shortcut-row-${command}`}
      className={`flex justify-between gap-5 py-3 ${isCapturing ? 'items-start' : 'items-center'}`}
    >
      <div className="min-w-0">
        <p className="text-body-sm font-medium text-settings-ink dark:text-dark-settings-ink">
          {metadata.label}
        </p>
        <p className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
          {metadata.description}
        </p>
      </div>
      {isCapturing ? (
        <ShortcutCapture
          command={command}
          bindings={bindings}
          onApply={onApply}
          onCancel={onCancelCapture}
        />
      ) : (
        <div className="flex shrink-0 items-center gap-2.5">
          {isOverridden && (
            <span className="rounded-full bg-settings-primary-container px-2 py-0.5 text-settings-badge uppercase text-settings-on-primary-container dark:bg-dark-settings-primary-container dark:text-dark-settings-on-primary-container">
              Custom
            </span>
          )}
          <button
            type="button"
            onClick={() => onStartCapture(command)}
            aria-label={`Change shortcut for ${metadata.label}`}
            className="cursor-pointer rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-settings-primary"
          >
            <KeyCaps bindings={bindings[command]} />
          </button>
          {isOverridden && (
            <button type="button" onClick={() => onReset(command)} className={settingsLinkPrimary}>
              Reset
            </button>
          )}
        </div>
      )}
    </div>
  );
}
