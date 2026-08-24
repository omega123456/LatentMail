import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { AiSection } from '@/components/settings/AiSection';
import { ipc } from '@/tests/ipc-mock';
import { renderWithQueryClient } from '@/tests/render-with-query-client';

it('renders one AI card for each configured account', async () => {
  ipc.override('read_ai_configs', [
    {
      accountId: 'a',
      email: 'a@example.com',
      displayName: 'Ada',
      enabled: true,
      baseUrl: null,
      chatModel: null,
      embeddingModel: null,
      embeddingDimensions: null,
      hasApiKey: false,
      indexPaused: false,
    },
    {
      accountId: 'b',
      email: 'b@example.com',
      displayName: 'Bob',
      enabled: false,
      baseUrl: null,
      chatModel: null,
      embeddingModel: null,
      embeddingDimensions: null,
      hasApiKey: false,
      indexPaused: false,
    },
  ]);
  renderWithQueryClient(<AiSection />);
  expect(await screen.findByText('Ada')).toBeTruthy();
  expect(screen.getByText('Bob')).toBeTruthy();
});

it('allows every card to be collapsed after the default setup card opens', async () => {
  const user = userEvent.setup();
  ipc.override('read_ai_configs', [
    {
      accountId: 'a',
      email: 'a@example.com',
      displayName: 'Ada',
      enabled: true,
      baseUrl: null,
      chatModel: null,
      embeddingModel: null,
      embeddingDimensions: null,
      hasApiKey: false,
      indexPaused: false,
    },
  ]);
  renderWithQueryClient(<AiSection />);
  const card = (await screen.findByText('Ada')).closest('button');
  if (!card) throw new Error('Missing AI account card');
  expect(card).toHaveAttribute('aria-expanded', 'true');
  await user.click(card);
  expect(card).toHaveAttribute('aria-expanded', 'false');
});
