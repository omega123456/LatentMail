import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { AiConnectionSection } from '@/components/settings/AiConnectionSection';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { ipc } from '@/tests/ipc-mock';

function renderSection() {
  return renderWithQueryClient(
    <AiConnectionSection
      accountId="account"
      baseUrl={null}
      hasApiKey={false}
      onChanged={() => undefined}
    />,
  );
}

it('renders account-scoped connection controls', async () => {
  ipc.override('test_ai_connection', 4);
  renderSection();
  expect(screen.getByLabelText('Endpoint URL')).toBeTruthy();
  expect(await screen.findByRole('button', { name: 'Test connection' })).toBeTruthy();
});

it('shows the polled connection state without pressing Test connection', async () => {
  ipc.override('test_ai_connection', 12);
  renderSection();
  expect(await screen.findByText('Connected')).toBeInTheDocument();
  expect(screen.getByText('12 models available')).toBeInTheDocument();
});

it('reports a failed poll and retries it from the card', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  ipc.override('test_ai_connection', () => {
    attempts += 1;
    if (attempts === 1) throw new Error('Connection refused');
    return 3;
  });
  renderSection();
  expect(await screen.findByText('Could not reach the endpoint')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Connected')).toBeInTheDocument();
  expect(attempts).toBe(2);
});

it('re-runs the shared poll from Test connection', async () => {
  const user = userEvent.setup();
  let attempts = 0;
  ipc.override('test_ai_connection', () => {
    attempts += 1;
    return attempts;
  });
  renderSection();
  expect(await screen.findByText('1 models available')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Test connection' }));
  await waitFor(() => expect(screen.getByText('2 models available')).toBeInTheDocument());
});
