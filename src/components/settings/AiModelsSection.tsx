import { useState } from 'react';
import { useAiModelsQuery } from '@/lib/query/hooks';
import { modelsOfKind } from '@/lib/ai/model-kind';
import { invoke } from '@/lib/ipc/commands';
import { SubsectionHeading } from './GeneralSection';
import { SettingsSubsection } from './SettingsSection';
import { ModelCardList } from './ModelCardList';
import type { AiIndexStatus } from '@/lib/types/ipc';
import { InlineConfirm } from './InlineConfirm';
import { settingsQuietButton } from './styles';

export function AiModelsSection({
  accountId,
  accountEmail,
  chatModel,
  embeddingModel,
  embeddingDimensions,
  indexStatus,
  onChanged,
}: {
  accountId: string;
  accountEmail: string;
  chatModel: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  indexStatus?: AiIndexStatus;
  onChanged: () => void;
}) {
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const models = useAiModelsQuery(accountId, revision, true);
  const selectEmbedding = async (model: string) => {
    try {
      await invoke('select_ai_embedding_model', { accountId, model });
      setError(null);
      setPendingModel(null);
      onChanged();
    } catch (reason) {
      setError(String(reason));
    }
  };
  const running = indexStatus?.state === 'preparing' || indexStatus?.state === 'building';
  const hasIndexData = Boolean(
    indexStatus && (indexStatus.indexedMessages > 0 || indexStatus.indexedPassages > 0),
  );
  return (
    <SettingsSubsection
      title="Models"
      description="Provider lists give no model type, so each list is matched by name."
      action={
        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          className={`shrink-0 ${settingsQuietButton}`}
        >
          Rescan
        </button>
      }
    >
      {models.isLoading && (
        <p className="text-settings-desc text-settings-ink-mute dark:text-dark-settings-ink-mute">
          Scanning models…
        </p>
      )}
      {models.isError && (
        <p role="alert" className="text-settings-desc text-settings-error">
          Couldn&apos;t scan models.
        </p>
      )}
      {models.data && (
        <>
          <div>
            <SubsectionHeading>Chat model</SubsectionHeading>
            <ModelCardList
              accountEmail={accountEmail}
              label="Chat"
              models={modelsOfKind(models.data, 'chat', chatModel)}
              selectedId={chatModel}
              onChange={(model) => {
                void invoke('select_ai_chat_model', { accountId, model }).then(onChanged);
              }}
            />
          </div>
          <div>
            <SubsectionHeading>Embedding model</SubsectionHeading>
            <ModelCardList
              accountEmail={accountEmail}
              label="Embedding"
              models={modelsOfKind(models.data, 'embedding', embeddingModel)}
              selectedId={embeddingModel}
              selectedDimension={embeddingDimensions}
              confirmAfterId={pendingModel}
              confirm={
                pendingModel && (
                  <InlineConfirm
                    title={`Rebuild AI index for ${accountEmail}?`}
                    body={`Vectors from a different model cannot be compared. This account's ${indexStatus?.indexedMessages.toLocaleString() ?? '0'} indexed messages will be removed and re-indexed from the start.${running ? ' The build now running will be cancelled.' : ''}`}
                    action="Change model"
                    onCancel={() => setPendingModel(null)}
                    onConfirm={() => void selectEmbedding(pendingModel)}
                  />
                )
              }
              onChange={(model) => {
                if (model !== embeddingModel && hasIndexData) setPendingModel(model);
                else void selectEmbedding(model);
              }}
            />
            <p className="mt-2.5 text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
              Dimensions are read from a live embedding call before saving.
            </p>
          </div>
          {error && (
            <p role="alert" className="text-settings-desc text-settings-error">
              {error}
            </p>
          )}
        </>
      )}
    </SettingsSubsection>
  );
}
