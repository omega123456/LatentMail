import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { ipcFixtures } from '@/tests/fixtures';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import { resetAppShellStores } from '@/tests/components/shell/app-shell-helpers';
import { readyAssistant } from '@/tests/components/shell/mail-layout-assistant-helpers';

const WIDENED_ASSISTANT_WIDTH = 460;
const ASSISTANT_WIDTH_MAX = 700;

beforeEach(() => {
  resetAppShellStores();
  act(() => useLayoutStore.setState({ layout: 'three-column', assistantOpen: false }));
});

it('opens the docked fourth column from the trigger and returns focus on close', async () => {
  const user = userEvent.setup();
  readyAssistant();
  render(<App />);
  const trigger = await screen.findByRole('button', { name: 'AI assistant' });
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(screen.getByTestId('assistant-docked')).toHaveAttribute('hidden');

  await user.click(trigger);
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByTestId('assistant-docked')).not.toHaveAttribute('hidden');
  expect(screen.queryByTestId('assistant-drawer')).toBeNull();
  await waitFor(() => expect(screen.getByLabelText('Ask a question')).toHaveFocus());

  await user.click(screen.getByRole('button', { name: 'Close panel' }));
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveFocus();
});

it('resizes the docked column and persists the clamped width', async () => {
  const user = userEvent.setup();
  readyAssistant();
  const writes: Array<{ key: string; value: unknown }> = [];
  ipc.override('write_setting', (request) => {
    writes.push(request);
  });
  render(<App />);
  await user.click(await screen.findByRole('button', { name: 'AI assistant' }));
  const handle = screen.getByRole('button', { name: 'Resize AI assistant' });

  fireEvent.pointerDown(handle, { clientX: 800 });
  fireEvent.pointerMove(window, { clientX: 700 });
  fireEvent.pointerUp(window);
  await waitFor(() =>
    expect(useLayoutStore.getState().assistantWidth).toBe(WIDENED_ASSISTANT_WIDTH),
  );

  fireEvent.pointerDown(handle, { clientX: 800 });
  fireEvent.pointerMove(window, { clientX: 0 });
  fireEvent.pointerUp(window);
  await waitFor(() => expect(useLayoutStore.getState().assistantWidth).toBe(ASSISTANT_WIDTH_MAX));
  expect(writes).toContainEqual({ key: 'assistantWidth', value: 700 });
});

it.each(['bottom-preview', 'list-only'] as const)(
  'opens as an overlay drawer in %s layout',
  async (layout) => {
    const user = userEvent.setup();
    readyAssistant();
    ipc.override('read_settings', { ...ipcFixtures.read_settings, layout });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'AI assistant' }));
    expect(screen.getByTestId('assistant-drawer')).not.toHaveAttribute('hidden');
    expect(screen.queryByTestId('assistant-docked')).toBeNull();
  },
);

it('closes the panel, returns focus to the trigger, and keeps the open thread', async () => {
  const user = userEvent.setup();
  readyAssistant();
  render(<App />);
  const trigger = await screen.findByRole('button', { name: 'AI assistant' });
  await user.click(trigger);
  act(() => useSelectionStore.getState().setActiveThreadId('thread-1'));
  screen.getByLabelText('Ask a question').focus();

  await user.keyboard('{Escape}');

  expect(useLayoutStore.getState().assistantOpen).toBe(false);
  expect(trigger).toHaveFocus();
  expect(useSelectionStore.getState().activeThreadId).toBe('thread-1');
});

it('toggles the panel from the keyboard command', async () => {
  readyAssistant();
  render(<App />);
  await screen.findByRole('button', { name: 'AI assistant' });
  act(() =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true })),
  );
  expect(useLayoutStore.getState().assistantOpen).toBe(true);
});
