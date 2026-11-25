import { useState } from 'react';
import { useAiModelsQuery } from '@/lib/query/hooks';
import { invoke } from '@/lib/ipc/commands';
import { SubsectionHeading } from './GeneralSection';
import { SettingsSubsection } from './SettingsSection';
import { ModelCardList } from './ModelCardList';
import type { AiIndexStatus, AiModel } from '@/lib/types/ipc';
import { InlineConfirm } from './InlineConfirm';
import { settingsQuietButton } from './styles';

function indexRebuildBody(indexStatus: AiIndexStatus | undefined, running: boolean): string {
  const count = indexStatus?.indexedMessages.toLocaleString() ?? '0';
  const cancelSuffix = running ? ' The build now running will be cancelled.' : '';
  return `Vectors from a different model cannot be compared. This account's ${count} indexed messages will be removed and re-indexed from the start.${cancelSuffix}`;
}

function hasExistingIndexData(indexStatus: AiIndexStatus | undefined): boolean {
  if (!indexStatus) return false;
  return indexStatus.indexedMessages > 0 || indexStatus.indexedPassages > 0;
}

type AiModelsContentProps = {
  accountId: string;
  accountEmail: string;
  models: AiModel[];
  chatModel: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  indexStatus?: AiIndexStatus;
  loadingModel: string | null;
  pendingModel: string | null;
  error: string | null;
  onChanged: () => void;
  onRequestEmbedding: (model: string) => void;
  onConfirmEmbedding: (model: string) => void;
  onCancelPending: () => void;
};

function AiModelsContent(props: AiModelsContentProps) {
  const running =
    props.indexStatus?.state === 'preparing' || props.indexStatus?.state === 'building';
  const pendingModel = props.pendingModel;
  return (
    <>
      <div>
        <SubsectionHeading>Chat model</SubsectionHeading>
        <ModelCardList
          accountEmail={props.accountEmail}
          label="Chat"
          kind="chat"
          models={props.models}
          selectedId={props.chatModel}
          onChange={(model) => {
            void invoke('select_ai_chat_model', { accountId: props.accountId, model: model }).then(
              props.onChanged,
            );
          }}
        />
      </div>
      <div>
        <SubsectionHeading>Embedding model</SubsectionHeading>
        <ModelCardList
          accountEmail={props.accountEmail}
          label="Embedding"
          kind="embedding"
          models={props.models}
          selectedId={props.embeddingModel}
          selectedDimension={props.embeddingDimensions}
          loadingId={props.loadingModel}
          confirm={
            pendingModel && (
              <InlineConfirm
                title={`Rebuild AI index for ${props.accountEmail}?`}
                body={indexRebuildBody(props.indexStatus, running)}
                action="Change model"
                onCancel={props.onCancelPending}
                onConfirm={() => props.onConfirmEmbedding(pendingModel)}
              />
            )
          }
          onChange={props.onRequestEmbedding}
        />
        <p className="mt-2.5 text-settings-meta text-settings-ink-mute dark:text-dark-settings-ink-mute">
          Dimensions are read from a live embedding call before saving.
        </p>
      </div>
      {props.error && (
        <p role="alert" className="text-settings-desc text-settings-error">
          {props.error}
        </p>
      )}
    </>
  );
}

type AiModelsSectionProps = {
  accountId: string;
  accountEmail: string;
  chatModel: string | null;
  embeddingModel: string | null;
  embeddingDimensions: number | null;
  indexStatus?: AiIndexStatus;
  onChanged: () => void;
};

function useEmbeddingSelection(props: AiModelsSectionProps) {
  const [error, setError] = useState<string | null>(null);
  const [pendingModel, setPendingModel] = useState<string | null>(null);
  const [loadingModel, setLoadingModel] = useState<string | null>(null);

  const selectEmbedding = async (model: string) => {
    setPendingModel(null);
    setLoadingModel(model);
    try {
      await invoke('select_ai_embedding_model', { accountId: props.accountId, model: model });
      setError(null);
      props.onChanged();
    } catch (reason) {
      setError(String(reason));
    } finally {
      setLoadingModel(null);
    }
  };

  const requestEmbeddingModel = (model: string) => {
    if (model !== props.embeddingModel && hasExistingIndexData(props.indexStatus)) {
      setPendingModel(model);
      return;
    }
    void selectEmbedding(model);
  };

  return {
    error,
    pendingModel,
    setPendingModel,
    loadingModel,
    selectEmbedding,
    requestEmbeddingModel,
  };
}

export function AiModelsSection(props: AiModelsSectionProps) {
  const [revision, setRevision] = useState(0);
  const models = useAiModelsQuery(props.accountId, revision, true);
  const embedding = useEmbeddingSelection(props);

  return (
    <SettingsSubsection
      title="Models"
      description="Provider lists give no model type, so each list is matched by name."
      action={
        <button
          type="button"
          onClick={() => setRevision((currentRevision) => currentRevision + 1)}
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
        <AiModelsContent
          {...props}
          models={models.data}
          loadingModel={embedding.loadingModel}
          pendingModel={embedding.pendingModel}
          error={embedding.error}
          onRequestEmbedding={embedding.requestEmbeddingModel}
          onConfirmEmbedding={(model) => void embedding.selectEmbedding(model)}
          onCancelPending={() => embedding.setPendingModel(null)}
        />
      )}
    </SettingsSubsection>
  );
}
