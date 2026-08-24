import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ModelCardList } from '@/components/settings/ModelCardList';

it('filters and selects model cards', async () => {
  const user = userEvent.setup();
  const change = vi.fn();
  render(
    <ModelCardList
      accountEmail="ada@example.com"
      label="Chat"
      selectedId={null}
      onChange={change}
      models={[
        { id: 'alpha', ownedBy: 'A' },
        { id: 'beta', ownedBy: 'B' },
      ]}
    />,
  );
  await user.type(screen.getByLabelText('Filter Chat models for ada@example.com'), 'beta');
  await user.click(screen.getByRole('radio', { name: /beta/i }));
  expect(change).toHaveBeenCalledWith('beta');
  expect(screen.queryByRole('radio', { name: /alpha/i })).toBeNull();
});

it('keeps only the selected model visible while a large catalogue is collapsed', () => {
  const models = Array.from({ length: 31 }, (_, index) => ({
    id: `model-${index}`,
    ownedBy: null,
  }));
  render(
    <ModelCardList
      accountEmail="ada@example.com"
      label="Embedding"
      selectedId="model-30"
      selectedDimension={1536}
      onChange={() => undefined}
      models={models}
    />,
  );
  expect(screen.getByRole('radio', { name: /model-30/i })).toBeTruthy();
  expect(screen.queryByRole('radio', { name: /model-0/i })).toBeNull();
  expect(screen.getByText('Currently selected')).toBeTruthy();
  expect(screen.getByLabelText('Selected')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Show all' })).toBeTruthy();
});
