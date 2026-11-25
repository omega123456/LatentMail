import { useEffect, useRef, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import { captureBinding, findConflictingCommand, isMacPlatform } from '@/lib/keyboard/format';
import { COMMAND_METADATA, type CommandBindings, type CommandName } from '@/lib/keyboard/registry';
import { KeyCaps } from './KeyCaps';
import { settingsLinkMuted, settingsLinkPrimary } from './styles';
import { ICON_SIZE } from '@/components/shared/icon-size';

const MODIFIER_KEYS = ['Meta', 'Control', 'Shift', 'Alt'];

function ShortcutCaptureButtons({
  applyDisabled,
  hasExistingBinding,
  onApply,
  onRemove,
  onCancel,
}: {
  applyDisabled: boolean;
  hasExistingBinding: boolean;
  onApply: () => void;
  onRemove: () => void;
  onCancel: () => void;
}) {
  const keepFocus = (event: React.MouseEvent) => event.preventDefault();
  return (
    <>
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={onApply}
        disabled={applyDisabled}
        className={settingsLinkPrimary}
      >
        Apply
      </button>
      {hasExistingBinding && (
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={onRemove}
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
    </>
  );
}

type ShortcutCaptureProps = {
  command: CommandName;
  bindings: CommandBindings;
  onApply: (command: CommandName, keys: string[]) => void;
  onCancel: () => void;
};

function ShortcutConflictAlert({ conflict }: { conflict: CommandName | null }) {
  if (!conflict) return null;
  return (
    <p
      role="alert"
      className="flex items-center gap-1.5 pt-1.75 text-settings-meta text-settings-error dark:text-dark-settings-error"
    >
      <TriangleAlert aria-hidden="true" size={ICON_SIZE.xs} />
      Already used by <b className="font-semibold">{COMMAND_METADATA[conflict].label}</b>
    </p>
  );
}

export function ShortcutCapture({ command, bindings, onApply, onCancel }: ShortcutCaptureProps) {
  const [captured, setCaptured] = useState<string[] | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const conflict = captured
    ? findConflictingCommand({
        bindings: bindings,
        command: command,
        candidate: captured[0],
        isMac: isMacPlatform(),
      })
    : null;

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.key === 'Escape') {
      onCancel();
      return;
    }
    if (MODIFIER_KEYS.includes(event.key)) return;
    setCaptured(captureBinding(event));
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
        <ShortcutCaptureButtons
          applyDisabled={!captured || Boolean(conflict)}
          hasExistingBinding={bindings[command].length > 0}
          onApply={() => {
            if (captured && !conflict) onApply(command, captured);
          }}
          onRemove={() => onApply(command, [])}
          onCancel={onCancel}
        />
      </div>
      <ShortcutConflictAlert conflict={conflict} />
    </div>
  );
}
