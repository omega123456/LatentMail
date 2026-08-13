import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '@/App';

it('renders the sign-in application when no accounts are configured', async () => {
  render(<App />);
  expect(await screen.findByTestId('sign-in-screen')).toBeInTheDocument();
});

afterEach(() => vi.resetModules());

it('mounts the application entry point', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => { await import('@/main'); });
  expect(await screen.findByTestId('sign-in-screen')).toBeInTheDocument();
});

it('fails clearly when the entry root is absent', async () => {
  document.body.innerHTML = '';

  await expect(import('@/main')).rejects.toThrow('Missing root element');
});
