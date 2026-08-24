import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { ApiKeyField } from '@/components/settings/ApiKeyField';
import { ipc } from '@/tests/ipc-mock';

it('opens confirmation before clearing a saved key', async () => {
  const user = userEvent.setup();
  render(<ApiKeyField accountId="account" hasKey onChanged={() => undefined} />);
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.getByText('Clear API key?')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(ipc.tauriInvoke).not.toHaveBeenCalled();
});

it('focuses the password editor and reveals only a replacement draft', async () => {
  const user = userEvent.setup();
  render(<ApiKeyField accountId="account" hasKey onChanged={() => undefined} />);
  await user.click(screen.getByRole('button', { name: 'Replace' }));
  const input = screen.getByLabelText('API key');
  await waitFor(() => expect(input).toHaveFocus());
  expect(input).toHaveAttribute('type', 'password');
  await user.click(screen.getByRole('button', { name: 'Show API key' }));
  expect(input).toHaveAttribute('type', 'text');
  expect(screen.queryByRole('button', { name: 'Show API key' })).toBeNull();
});

it('keeps a saved key when clearing it fails', async () => {
  const user = userEvent.setup();
  ipc.override('clear_ai_api_key', () => {
    throw new Error('Keychain unavailable');
  });
  render(<ApiKeyField accountId="account" hasKey onChanged={() => undefined} />);
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Keychain unavailable');
  expect(screen.getByRole('button', { name: 'Replace' })).toBeInTheDocument();
});
