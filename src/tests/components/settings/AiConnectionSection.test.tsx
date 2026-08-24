import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { AiConnectionSection } from '@/components/settings/AiConnectionSection';

it('renders account-scoped connection controls', () => {
  render(
    <AiConnectionSection
      accountId="account"
      baseUrl={null}
      hasApiKey={false}
      onChanged={() => undefined}
    />,
  );
  expect(screen.getByLabelText('Endpoint URL')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Test connection' })).toBeTruthy();
});
