import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ModelCardList } from '@/components/settings/ModelCardList';

it('filters and selects a model from the dropdown', async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <ModelCardList
      accountEmail="ada@example.com"
      label="Chat"
      kind="chat"
      selectedId={null}
      onChange={change}
      models={[
        { id: 'alpha', ownedBy: 'A' },
        { id: 'beta', ownedBy: 'B' },
      ]}
    />,
  );
  await user.click(screen.getByRole('combobox', { name: 'Chat model for ada@example.com' }));
  await user.type(await screen.findByLabelText('Filter Chat models for ada@example.com'), 'beta');
  await user.click(screen.getByRole('option', { name: /beta/i }));
  expect(change).toHaveBeenCalledWith('beta');
  expect(screen.queryByRole('option', { name: /alpha/i })).toBeNull();
});

it('shows the selected model and its dimensions on the trigger', () => {
  const models = Array.from({ length: 31 }, (_, index) => ({
    id: `model-${index}`,
    ownedBy: null,
  }));
  render(
    <ModelCardList
      accountEmail="ada@example.com"
      label="Embedding"
      kind="embedding"
      selectedId="model-30"
      selectedDimension={1536}
      onChange={() => undefined}
      models={models}
    />,
  );
  const trigger = screen.getByRole('combobox', { name: 'Embedding model for ada@example.com' });
  expect(trigger).toHaveTextContent('model-30');
  expect(trigger).toHaveTextContent('1,536 dimensions');
});

it('keeps focus on the filter while the selected model mounts and unmounts from filtering', async () => {
  const user = userEvent.setup();
  render(
    <ModelCardList
      accountEmail="ada@example.com"
      label="Embedding"
      kind="embedding"
      selectedId="old"
      selectedDimension={1536}
      onChange={() => undefined}
      models={[
        { id: 'old', ownedBy: 'A' },
        { id: 'new', ownedBy: 'B' },
      ]}
    />,
  );
  await user.click(
    screen.getByRole('combobox', { name: 'Embedding model for ada@example.com' }),
  );
  const input = await screen.findByLabelText('Filter Embedding models for ada@example.com');
  await user.type(input, 'new');
  expect(document.activeElement).toBe(input);
  await user.keyboard('{Backspace}{Backspace}{Backspace}');
  expect(document.activeElement).toBe(input);
});

it('navigates from the filter into the options and back with arrow keys', async () => {
  const user = userEvent.setup();
  render(
    <ModelCardList
      accountEmail="ada@example.com"
      label="Chat"
      kind="chat"
      selectedId={null}
      onChange={() => undefined}
      models={[
        { id: 'alpha', ownedBy: 'A' },
        { id: 'beta', ownedBy: 'B' },
      ]}
    />,
  );
  await user.click(screen.getByRole('combobox', { name: 'Chat model for ada@example.com' }));
  const input = await screen.findByLabelText('Filter Chat models for ada@example.com');
  const firstOption = screen.getByRole('option', { name: /alpha/i });

  await user.keyboard('{ArrowDown}');
  expect(document.activeElement).toBe(firstOption);

  await user.keyboard('{ArrowUp}');
  expect(document.activeElement).toBe(input);
});

it('reveals models the name filter assigns to the other kind', async () => {
  const user = userEvent.setup();
  render(
    <ModelCardList
      accountEmail="ada@example.com"
      label="Embedding"
      kind="embedding"
      selectedId={null}
      onChange={() => undefined}
      models={[
        { id: 'bge-m3', ownedBy: 'library' },
        { id: 'nomic-embed-text', ownedBy: 'library' },
      ]}
    />,
  );
  await user.click(screen.getByRole('combobox', { name: 'Embedding model for ada@example.com' }));
  expect(screen.queryByRole('option', { name: /bge-m3/ })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Show all' }));
  await user.click(await screen.findByRole('option', { name: /bge-m3/ }));
  expect(screen.getByRole('combobox', { name: 'Embedding model for ada@example.com' })).toBeTruthy();
});

it('leaves no highlight behind when the pointer moves between options', async () => {
  const user = userEvent.setup();
  render(
    <ModelCardList
      accountEmail="ada@example.com"
      label="Chat"
      kind="chat"
      selectedId={null}
      onChange={() => undefined}
      models={[
        { id: 'alpha', ownedBy: 'A' },
        { id: 'beta', ownedBy: 'B' },
      ]}
    />,
  );
  await user.click(screen.getByRole('combobox', { name: 'Chat model for ada@example.com' }));
  const input = await screen.findByLabelText('Filter Chat models for ada@example.com');
  const first = screen.getByRole('option', { name: /alpha/ });
  const second = screen.getByRole('option', { name: /beta/ });

  await user.hover(first);
  await user.hover(second);

  expect(first).not.toHaveAttribute('data-highlighted');
  expect(second).not.toHaveAttribute('data-highlighted');
  expect(document.activeElement).toBe(input);
});
