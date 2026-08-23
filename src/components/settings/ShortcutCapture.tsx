import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { captureBinding, findConflictingCommand, isMacPlatform } from '@/lib/keyboard/format';
import { COMMAND_METADATA, type CommandBindings, type CommandName } from '@/lib/keyboard/registry';
import { KeyCaps } from './KeyCaps';
import { settingsLinkMuted, settingsLinkPrimary } from './styles';

export function ShortcutCapture({
  command,
  bindings,
  onApply,
  onCancel,
}: {
  command: CommandName;
  bindings: CommandBindings;
  onApply: (command: CommandName, keys: string[]) => void;
  onCancel: () => void;
}) {
  const [captured, setCaptured] = useState<string[] | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const isMac = isMacPlatform();
  const conflict = captured ? findConflictingCommand(bindings, command, captured[0], isMac) : null;

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.key === 'Escape') {
      onCancel();
      return;
    }
    if (['Meta', 'Control', 'Shift', 'Alt'].includes(event.key)) return;
    setCaptured(captureBinding(event));
  };

  const keepFocus = (event: React.MouseEvent) => event.preventDefault();

  const apply = () => {
    if (!captured || conflict) return;
    onApply(command, captured);
  };

  return (
    <div
      className="flex shrink-0 flex-col items-end"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) onCancel();
      }}
    >
      <div className="flex items-center gap-2.5">
        <div
          ref={fieldRef}
          tabIndex={0}
          role="textbox"
          aria-label={`Recording new shortcut for ${COMMAND_METADATA[command].label}`}
          onKeyDown={handleKeyDown}
          className="flex items-center gap-2.5 rounded-control bg-settings-container-low px-3 py-1.5 text-settings-meta text-settings-ink-mute ring-2 ring-inset ring-settings-primary focus:outline-none dark:bg-dark-settings-container-low dark:text-dark-settings-ink-mute dark:ring-dark-settings-primary"
        >
          {captured ? <KeyCaps bindings={captured} /> : <span>Recording…</span>}
        </div>
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={apply}
          disabled={!captured || Boolean(conflict)}
          className={settingsLinkPrimary}
        >
          Apply
        </button>
        {bindings[command].length > 0 && (
          <button
            type="button"
            onMouseDown={keepFocus}
            onClick={() => onApply(command, [])}
            className={settingsLinkMuted}
          >
            Remove
          </button>
        )}
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={onCancel}
          className={settingsLinkMuted}
        >
          Cancel
        </button>
      </div>
      {conflict && (
        <p
          role="alert"
          className="flex items-center gap-1.5 pt-1.75 text-settings-meta text-settings-error dark:text-dark-settings-error"
        >
          <TriangleAlert aria-hidden="true" size={13} />
          Already used by <b className="font-semibold">{COMMAND_METADATA[conflict].label}</b>
        </p>
      )}
    </div>
  );
}
