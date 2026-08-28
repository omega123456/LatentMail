import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { AiModelsSection } from '@/components/settings/AiModelsSection';
import { ipc } from '@/tests/ipc-mock';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

async function pickEmbeddingModel(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(
    await screen.findByRole('combobox', { name: 'Embedding model for ada@example.com' }),
  );
  await user.click(screen.getByRole('option', { name }));
}

it('renders an account model catalogue', async () => {
  ipc.override('list_ai_models', [{ id: 'model', ownedBy: 'owner' }]);
  renderWithQueryClient(
    <AiModelsSection
      accountId="account"
      accountEmail="ada@example.com"
      chatModel={null}
      embeddingModel={null}
      embeddingDimensions={null}
      onChanged={() => undefined}
    />,
  );
  expect(await screen.findAllByRole('combobox')).toHaveLength(2);
});

it('warns before changing an indexed embedding model', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  ipc.override('select_ai_embedding_model', (args) => {
    select(args);
  });
  ipc.override('list_ai_models', [
    { id: 'old', ownedBy: 'owner' },
    { id: 'new', ownedBy: 'owner' },
  ]);
  renderWithQueryClient(
    <AiModelsSection
      accountId="account"
      accountEmail="ada@example.com"
      chatModel={null}
      embeddingModel="old"
      embeddingDimensions={1536}
      indexStatus={{
        accountId: 'account',
        state: 'building',
        indexed: 4,
        total: 8,
        indexedMessages: 4,
        totalEligibleMessages: 8,
        indexedPassages: 12,
        paused: false,
        error: null,
      }}
      onChanged={() => undefined}
    />,
  );
  await pickEmbeddingModel(user, /new/i);
  expect(screen.getByRole('alert')).toHaveTextContent('Rebuild AI index for ada@example.com?');
  expect(screen.getByRole('alert')).toHaveTextContent('The build now running will be cancelled.');
  expect(select).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Change model' }));
  expect(select).toHaveBeenCalledWith({
    accountId: 'account',
    model: 'new',
  });
});

it('changes an embedding model without confirmation when only eligible mail exists', async () => {
  const user = userEvent.setup();
  const select = vi.fn();
  ipc.override('select_ai_embedding_model', (args) => {
    select(args);
  });
  ipc.override('list_ai_models', [
    { id: 'old', ownedBy: 'owner' },
    { id: 'new', ownedBy: 'owner' },
  ]);
  renderWithQueryClient(
    <AiModelsSection
      accountId="account"
      accountEmail="ada@example.com"
      chatModel={null}
      embeddingModel="old"
      embeddingDimensions={1536}
      indexStatus={{
        accountId: 'account',
        state: 'notStarted',
        indexed: 0,
        total: 8,
        indexedMessages: 0,
        totalEligibleMessages: 8,
        indexedPassages: 0,
        paused: false,
        error: null,
      }}
      onChanged={() => undefined}
    />,
  );
  await pickEmbeddingModel(user, /new/i);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(select).toHaveBeenCalledWith({
    accountId: 'account',
    model: 'new',
  });
});

it('does not claim a partial index has a running build to cancel', async () => {
  const user = userEvent.setup();
  ipc.override('list_ai_models', [
    { id: 'old', ownedBy: 'owner' },
    { id: 'new', ownedBy: 'owner' },
  ]);
  renderWithQueryClient(
    <AiModelsSection
      accountId="account"
      accountEmail="ada@example.com"
      chatModel={null}
      embeddingModel="old"
      embeddingDimensions={1536}
      indexStatus={{
        accountId: 'account',
        state: 'partial',
        indexed: 4,
        total: 8,
        indexedMessages: 4,
        totalEligibleMessages: 8,
        indexedPassages: 12,
        paused: false,
        error: null,
      }}
      onChanged={() => undefined}
    />,
  );
  await pickEmbeddingModel(user, /new/i);
  expect(screen.getByRole('alert')).not.toHaveTextContent(
    'The build now running will be cancelled.',
  );
});

it('shows the embedding model loading while the provider reads its vector length', async () => {
  const user = userEvent.setup();
  let release = () => undefined as void;
  ipc.override(
    'select_ai_embedding_model',
    () =>
      new Promise<undefined>((resolve) => {
        release = () => resolve(undefined);
      }),
  );
  ipc.override('list_ai_models', [
    { id: 'old', ownedBy: 'owner' },
    { id: 'new', ownedBy: 'owner' },
  ]);
  renderWithQueryClient(
    <AiModelsSection
      accountId="account"
      accountEmail="ada@example.com"
      chatModel={null}
      embeddingModel="old"
      embeddingDimensions={1536}
      onChanged={() => undefined}
    />,
  );
  await pickEmbeddingModel(user, /new/i);
  const trigger = screen.getByRole('combobox', { name: 'Embedding model for ada@example.com' });
  expect(trigger).toHaveTextContent('Loading model…');
  expect(trigger).toBeDisabled();
  await act(async () => {
    release();
  });
  expect(
    screen.getByRole('combobox', { name: 'Embedding model for ada@example.com' }),
  ).toBeEnabled();
});
