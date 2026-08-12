import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { SignInScreen } from '@/components/auth/SignInScreen';
import { ipc } from '@/tests/ipc-mock';

it('reports the underlying Rust error so a failed sign-in can be debugged', async () => {
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  ipc.override('begin_sign_in', () => {
    throw new Error('invalid_client: client_secret is missing');
  });
  const user = userEvent.setup();
  render(<SignInScreen />);

  await user.click(screen.getByRole('button', { name: 'Continue with Google' }));

  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not start Google sign-in: invalid_client: client_secret is missing',
  );
  expect(consoleError).toHaveBeenCalledWith(
    'ipc begin_sign_in failed: invalid_client: client_secret is missing',
  );
  consoleError.mockRestore();
});

it('dismisses the error and re-enables the button after a failure', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  ipc.override('begin_sign_in', () => {
    throw new Error('nope');
  });
  const user = userEvent.setup();
  render(<SignInScreen />);

  await user.click(screen.getByRole('button', { name: 'Continue with Google' }));
  await user.click(await screen.findByRole('button', { name: 'Dismiss sign-in error' }));

  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Continue with Google' })).toBeEnabled();
});

it('stays in the signing-in state while the OAuth flow is running', async () => {
  ipc.override('begin_sign_in', () => new Promise<void>(() => {}));
  const user = userEvent.setup();
  render(<SignInScreen />);

  await user.click(screen.getByRole('button', { name: 'Continue with Google' }));

  expect(await screen.findByRole('button', { name: 'Signing in…' })).toBeDisabled();
});
