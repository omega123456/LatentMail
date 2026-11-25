import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import App from '@/App';
import { useLayoutStore } from '@/stores/layout';
import { resetAppShellStores } from '@/tests/components/shell/app-shell-helpers';
import { readyAssistant } from '@/tests/components/shell/mail-layout-assistant-helpers';

const NARROW_SHELL_WIDTH = 900;
const WIDE_SHELL_WIDTH = 1400;

function resizeShell(width: number) {
  act(() =>
    (window.__resizeObserverInstances__ ?? []).forEach((instance) =>
      instance.callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver),
    ),
  );
}

beforeEach(() => {
  resetAppShellStores();
  act(() => useLayoutStore.setState({ layout: 'three-column', assistantOpen: true }));
});

it('swaps the docked column for the drawer below the threshold and back above it', async () => {
  readyAssistant();
  render(<App />);
  await screen.findByTestId('assistant-docked');

  resizeShell(NARROW_SHELL_WIDTH);
  expect(await screen.findByTestId('assistant-drawer')).toBeInTheDocument();
  expect(screen.queryByTestId('assistant-docked')).toBeNull();

  resizeShell(WIDE_SHELL_WIDTH);
  expect(await screen.findByTestId('assistant-docked')).toBeInTheDocument();
  expect(screen.queryByTestId('assistant-drawer')).toBeNull();
});
