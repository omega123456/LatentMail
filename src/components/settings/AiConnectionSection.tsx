import { useState } from 'react';
import { TextInput } from '@/components/shared/TextInput';
import { invoke } from '@/lib/ipc/commands';
import { useAiConnectionQuery } from '@/lib/query/hooks';
import { SettingRow } from './SettingRow';
import { SettingsSubsection } from './SettingsSection';
import { AiStatusCard } from './AiStatusCard';
import { ApiKeyField } from './ApiKeyField';
import { aiFieldSaveButton, settingsButton, settingsQuietButton } from './styles';

export function AiConnectionSection({
  accountId,
  baseUrl,
  hasApiKey,
  onChanged,
}: {
  accountId: string;
  baseUrl: string | null;
  hasApiKey: boolean;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState(baseUrl ?? '');
  const [error, setError] = useState<string | null>(null);
  const connection = useAiConnectionQuery(accountId);

  const save = async () => {
    try {
      await invoke('set_ai_base_url', { accountId, baseUrl: draft });
      setError(null);
      onChanged();
    } catch (reason) {
      setError(String(reason));
    }
  };

  const test = () => {
    void connection.refetch();
  };

  return (
    <SettingsSubsection
      title="Connection"
      description="Any OpenAI-compatible endpoint."
      action={
        <button
          type="button"
          onClick={test}
          disabled={connection.isFetching}
          className={`shrink-0 ${settingsButton} disabled:cursor-not-allowed disabled:opacity-60`}
        >
          {connection.isFetching ? 'Testing…' : 'Test connection'}
        </button>
      }
    >
      <div aria-live="polite">
        {connection.isFetching && <AiStatusCard pip="busy" spinner title="Testing connection" />}
        {!connection.isFetching && connection.isSuccess && (
          <AiStatusCard
            tone="success"
            pip="success"
            title="Connected"
            detail={`${connection.data.toLocaleString()} models available`}
          />
        )}
        {!connection.isFetching && connection.isError && (
          <AiStatusCard
            tone="error"
            pip="error"
            title="Could not reach the endpoint"
            detail={String(connection.error)}
            action={
              <button type="button" onClick={test} className={`shrink-0 ${settingsQuietButton}`}>
                Retry
              </button>
            }
          />
        )}
      </div>
      <div className="flex flex-col">
        <SettingRow label="Endpoint URL" description="Base URL including its version path.">
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-2.5">
              <TextInput
                aria-label="Endpoint URL"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                }}
                className="w-ai-field"
              />
              <span className="flex w-ai-action justify-end gap-2">
                <button type="button" onClick={() => void save()} className={aiFieldSaveButton}>
                  Save
                </button>
              </span>
            </div>
            {error && (
              <span role="alert" className="text-settings-meta text-settings-error">
                {error}
              </span>
            )}
          </div>
        </SettingRow>
        <SettingRow label="API key" description="Stored in the OS keychain.">
          <ApiKeyField accountId={accountId} hasKey={hasApiKey} onChanged={onChanged} />
        </SettingRow>
      </div>
    </SettingsSubsection>
  );
}
