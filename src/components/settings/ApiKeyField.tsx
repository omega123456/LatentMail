import { Eye, EyeOff } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { TextInput } from '@/components/shared/TextInput';
import { invoke } from '@/lib/ipc/commands';
import { InlineConfirm } from './InlineConfirm';
import { aiFieldSaveButton, settingsLinkMuted, settingsLinkPrimary } from './styles';

export function ApiKeyField({
  accountId,
  hasKey,
  onChanged,
}: {
  accountId: string;
  hasKey: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(!hasKey);
  const [visible, setVisible] = useState(false);
  const [value, setValue] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = async () => {
    try {
      await invoke('set_ai_api_key', { accountId, apiKey: value });
      setValue('');
      setEditing(false);
      setVisible(false);
      setError(null);
      onChanged();
    } catch (reason) {
      setError(String(reason));
    }
  };

  const cancel = () => {
    setValue('');
    setVisible(false);
    setEditing(false);
    setError(null);
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

  if (confirming) {
    return (
      <InlineConfirm
        title="Clear API key?"
        body="Provider requests will no longer use this key."
        action="Clear"
        onCancel={() => setConfirming(false)}
        onConfirm={() => void clear()}
      />
    );
  }

  if (!editing && hasKey) {
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
            <button type="button" onClick={() => setEditing(true)} className={settingsLinkPrimary}>
              Replace
            </button>
            <button type="button" onClick={() => setConfirming(true)} className={settingsLinkMuted}>
              Clear
            </button>
          </span>
        </div>
        <span aria-live="polite" className="sr-only">
          API key saved
        </span>
        {error && (
          <span role="alert" className="text-settings-meta text-settings-error">
            {error}
          </span>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2.5">
        <span className="relative flex w-ai-field items-center">
          <TextInput
            ref={inputRef}
            aria-label="API key"
            type={visible ? 'text' : 'password'}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            className="w-full pr-8"
          />
          <button
            type="button"
            aria-label={visible ? 'Hide API key' : 'Show API key'}
            onClick={() => setVisible((current) => !current)}
            className="absolute right-1.5 grid size-6 cursor-pointer place-items-center rounded-sm text-settings-ink-mute focus-visible:outline-2 focus-visible:outline-settings-primary dark:text-dark-settings-ink-mute"
          >
            {visible ? (
              <EyeOff aria-hidden="true" size={15} />
            ) : (
              <Eye aria-hidden="true" size={15} />
            )}
          </button>
        </span>
        <span className="flex w-ai-action items-center justify-end gap-2">
          <button type="button" onClick={() => void save()} className={aiFieldSaveButton}>
            Save
          </button>
          {hasKey && (
            <button type="button" onClick={cancel} className={settingsLinkMuted}>
              Cancel
            </button>
          )}
        </span>
      </div>
      <span aria-live="polite" className="sr-only">
        {editing ? 'Editing API key' : 'API key saved'}
      </span>
      {error && (
        <span role="alert" className="text-settings-meta text-settings-error">
          {error}
        </span>
      )}
    </div>
  );
}
