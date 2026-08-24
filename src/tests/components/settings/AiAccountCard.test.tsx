import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AiAccountCard } from '@/components/settings/AiAccountCard';

it('keeps disabled account configuration hidden', () => {
  render(
    <AiAccountCard
      expanded
      config={{
        accountId: 'account',
        email: 'person@example.com',
        displayName: 'Person',
        enabled: false,
        baseUrl: null,
        chatModel: null,
        embeddingModel: null,
        embeddingDimensions: null,
        hasApiKey: false,
        indexPaused: false,
      }}
      onToggle={() => undefined}
      onChanged={() => undefined}
    />,
  );
  expect(screen.getByText('Off')).toBeTruthy();
  expect(screen.queryByText('Connection')).toBeNull();
});
