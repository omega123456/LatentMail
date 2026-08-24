import type { AiModel } from '@/lib/types/ipc';

const EMBEDDING_HINT = /embed/i;

export function isEmbeddingModel(model: AiModel) {
  return EMBEDDING_HINT.test(model.id);
}

export function modelsOfKind(
  models: AiModel[],
  kind: 'chat' | 'embedding',
  selectedId: string | null,
) {
  const matched = models.filter((model) =>
    kind === 'embedding' ? isEmbeddingModel(model) : !isEmbeddingModel(model),
  );
  if (matched.length === 0) return models;
  const selected = models.find((model) => model.id === selectedId);
  if (selected && !matched.includes(selected)) return [selected, ...matched];
  return matched;
}
