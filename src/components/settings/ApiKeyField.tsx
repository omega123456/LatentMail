import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TextInput } from '@/components/shared/TextInput';
import { invoke } from '@/lib/ipc/commands';
import { InlineConfirm } from './InlineConfirm';
import { aiFieldSaveButton, settingsLinkMuted, settingsLinkPrimary } from './styles';
import { ICON_SIZE } from '@/components/shared/icon-size';

function ApiKeyError({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <span role="alert" className="text-settings-meta text-settings-error">
      {error}
    </span>
  );
}

function SavedApiKeyField({
  error,
  onReplace,
  onClear,
}: {
  error: string | null;
  onReplace: () => void;
  onClear: () => void;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2.5">
        <TextInput
          aria-label="Saved API key"
          value="••••••••••••"
          readOnly
          className="w-ai-field tracking-widest text-settings-ink-mute dark:text-dark-settings-ink-mute"
        />
        <span className="flex w-ai-action items-center justify-end gap-2">
          <button type="button" onClick={onReplace} className={settingsLinkPrimary}>
            Replace
          </button>
          <button type="button" onClick={onClear} className={settingsLinkMuted}>
            Clear
          </button>
        </span>
      </div>
      <span aria-live="polite" className="sr-only">
        API key saved
      </span>
      <ApiKeyError error={error} />
    </div>
  );
}

type EditingApiKeyFieldProps = {
  inputRef: React.RefObject<HTMLInputElement | null>;
  value: string;
  visible: boolean;
  hasKey: boolean;
  editing: boolean;
  error: string | null;
  onChange: (next: string) => void;
  onToggleVisible: () => void;
  onSave: () => void;
  onCancel: () => void;
};

function EditingApiKeyField({
  inputRef,
  value,
  visible,
  hasKey,
  editing,
  error,
  onChange,
  onToggleVisible,
  onSave,
  onCancel,
}: EditingApiKeyFieldProps) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2.5">
        <span className="relative flex w-ai-field items-center">
          <TextInput
            ref={inputRef}
            aria-label="API key"
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="w-full pr-8"
          />
          <button
            type="button"
            aria-label={visible ? 'Hide API key' : 'Show API key'}
            onClick={onToggleVisible}
            className="absolute right-1.5 grid size-6 cursor-pointer place-items-center rounded-sm text-settings-ink-mute focus-visible:outline-2 focus-visible:outline-settings-primary dark:text-dark-settings-ink-mute"
          >
            {visible ? (
              <EyeOff aria-hidden="true" size={ICON_SIZE.md} />
            ) : (
              <Eye aria-hidden="true" size={ICON_SIZE.md} />
            )}
          </button>
        </span>
        <span className="flex w-ai-action items-center justify-end gap-2">
          <button type="button" onClick={onSave} className={aiFieldSaveButton}>
            Save
          </button>
          {hasKey && (
            <button type="button" onClick={onCancel} className={settingsLinkMuted}>
              Cancel
            </button>
          )}
        </span>
      </div>
      <span aria-live="polite" className="sr-only">
        {editing ? 'Editing API key' : 'API key saved'}
      </span>
      <ApiKeyError error={error} />
    </div>
  );
}

function useApiKeyEditor(accountId: string, hasKey: boolean, onChanged: () => void) {
  const [editing, setEditing] = useState(!hasKey);
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const resetDraft = () => {
    setValue('');
    setVisible(false);
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    try {
      await invoke('set_ai_api_key', { accountId: accountId, apiKey: value });
      resetDraft();
      onChanged();
    } catch (reason) {
      setError(String(reason));
    }
  };

  const clear = async () => {
    try {
      await invoke('clear_ai_api_key', { accountId });
      setConfirming(false);
      setEditing(true);
      setError(null);
      onChanged();
    } catch (reason) {
      setConfirming(false);
      setError(String(reason));
    }
  };

  const cancel = resetDraft;
  return {
    editing,
    setEditing,
    visible,
    setVisible,
    value,
    setValue,
    confirming,
    setConfirming,
    error,
    inputRef,
    save,
    cancel,
    clear,
  };
}

export function ApiKeyField({
  accountId,
  hasKey,
  onChanged,
}: {
  accountId: string;
  hasKey: boolean;
  onChanged: () => void;
}) {
  const state = useApiKeyEditor(accountId, hasKey, onChanged);

  if (state.confirming) {
    return (
      <InlineConfirm
        title="Clear API key?"
        body="Provider requests will no longer use this key."
        action="Clear"
        onCancel={() => state.setConfirming(false)}
        onConfirm={() => void state.clear()}
      />
    );
  }

  if (!state.editing && hasKey) {
    return (
      <SavedApiKeyField
        error={state.error}
        onReplace={() => state.setEditing(true)}
        onClear={() => state.setConfirming(true)}
      />
    );
  }

  return (
    <EditingApiKeyField
      inputRef={state.inputRef}
      value={state.value}
      visible={state.visible}
      hasKey={hasKey}
      editing={state.editing}
      error={state.error}
      onChange={state.setValue}
      onToggleVisible={() => state.setVisible((current) => !current)}
      onSave={() => void state.save()}
      onCancel={state.cancel}
    />
  );
}
