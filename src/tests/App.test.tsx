import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import App from '@/App';

const createdRoots = vi.hoisted(() => [] as { unmount(): void }[]);

vi.mock('react-dom/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-dom/client')>();
  return {
    ...actual,
    createRoot: (...rootArguments: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...rootArguments);
      createdRoots.push(root);
      return root;
    },
  };
});

function unmountCreatedRoots() {
  act(() => createdRoots.splice(0).forEach((root) => root.unmount()));
}

it('renders the sign-in application when no accounts are configured', async () => {
  render(<App />);
  expect(await screen.findByTestId('sign-in-screen')).toBeInTheDocument();
});

afterEach(() => vi.resetModules());

it('mounts the application entry point', async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await act(async () => {
    await import('@/main');
  });
  expect(await screen.findByTestId('sign-in-screen')).toBeInTheDocument();
  unmountCreatedRoots();
});

it('fails clearly when the entry root is absent', async () => {
  document.body.innerHTML = '';

  await expect(import('@/main')).rejects.toThrow('Missing root element');
});
