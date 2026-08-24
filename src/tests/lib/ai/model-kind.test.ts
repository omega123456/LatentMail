import { expect, it } from 'vitest';
import { modelsOfKind } from '@/lib/ai/model-kind';

const catalogue = [
  { id: 'gpt-4o-mini', ownedBy: 'openai' },
  { id: 'text-embedding-3-small', ownedBy: 'openai' },
  { id: 'nomic-embed-text', ownedBy: 'local' },
];

it('splits a catalogue by the embedding hint in the model id', () => {
  expect(modelsOfKind(catalogue, 'chat', null).map((model) => model.id)).toEqual(['gpt-4o-mini']);
  expect(modelsOfKind(catalogue, 'embedding', null).map((model) => model.id)).toEqual([
    'text-embedding-3-small',
    'nomic-embed-text',
  ]);
});

it('falls back to the whole catalogue when a kind matches nothing', () => {
  const chatOnly = [{ id: 'llama-3', ownedBy: 'local' }];
  expect(modelsOfKind(chatOnly, 'embedding', null)).toEqual(chatOnly);
});

it('keeps a selected model listed even when the hint puts it in the other kind', () => {
  expect(modelsOfKind(catalogue, 'chat', 'nomic-embed-text').map((model) => model.id)).toEqual([
    'nomic-embed-text',
    'gpt-4o-mini',
  ]);
});
