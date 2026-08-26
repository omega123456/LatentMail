import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import App from '@/App';
import { ipc } from '@/tests/ipc-mock';
import { ipcFixtures } from '@/tests/fixtures';
import { useLayoutStore } from '@/stores/layout';
import { useSelectionStore } from '@/stores/selection';
import type { AiConfig, AiIndexStatus } from '@/lib/types/ipc';

const account = {
  id: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  avatarUrl: null,
  needsReauthentication: false,
};

beforeEach(() => {
  act(() => {
    useSelectionStore.setState({
      activeAccountId: null,
      activeMailboxId: null,
      activeThreadId: null,
      keyboardCursor: null,
    });
  });
});

const aiConfig: AiConfig = {
  accountId: 'account-1',
  email: 'alex@example.com',
  displayName: 'Alex Morgan',
  enabled: true,
  baseUrl: 'https://api.example.com/v1',
  chatModel: 'chat',
  embeddingModel: 'embedding',
  embeddingDimensions: 768,
  hasApiKey: true,
  indexPaused: false,
};

const aiStatus: AiIndexStatus = {
  accountId: 'account-1',
  state: 'complete',
  indexed: 10,
  total: 10,
  indexedMessages: 10,
  totalEligibleMessages: 10,
  indexedPassages: 30,
  paused: false,
  error: null,
};

function readyAssistant() {
  ipc.override('list_accounts', [account]);
  ipc.override('read_ai_configs', [aiConfig]);
  ipc.override('read_ai_index_status', [aiStatus]);
  ipc.override('test_ai_connection', 4);
}

function resizeShell(width: number) {
  act(() =>
    (window.__resizeObserverInstances__ ?? []).forEach((instance) =>
      instance.callback([{ contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver),
    ),
  );
}

describe('MailLayout — assistant panel docking and the top-bar trigger', () => {
  beforeEach(() => {
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
    ipc.override('write_setting', (args) => {
      writes.push(args);
    });
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'AI assistant' }));
    const handle = screen.getByRole('button', { name: 'Resize AI assistant' });

    fireEvent.pointerDown(handle, { clientX: 800 });
    fireEvent.pointerMove(window, { clientX: 700 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(useLayoutStore.getState().assistantWidth).toBe(460));

    fireEvent.pointerDown(handle, { clientX: 800 });
    fireEvent.pointerMove(window, { clientX: 0 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(useLayoutStore.getState().assistantWidth).toBe(700));
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
});

describe('MailLayout — narrow shell falls back to the drawer', () => {
  beforeEach(() => {
    act(() => useLayoutStore.setState({ layout: 'three-column', assistantOpen: true }));
  });

  it('swaps the docked column for the drawer below the threshold and back above it', async () => {
    readyAssistant();
    render(<App />);
    await screen.findByTestId('assistant-docked');

    resizeShell(900);
    expect(await screen.findByTestId('assistant-drawer')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-docked')).toBeNull();

    resizeShell(1400);
    expect(await screen.findByTestId('assistant-docked')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-drawer')).toBeNull();
  });
});

describe('MailLayout — Escape inside the assistant leaves the mail selection alone', () => {
  beforeEach(() => {
    act(() => useLayoutStore.setState({ layout: 'three-column', assistantOpen: false }));
  });

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
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'a', metaKey: true, shiftKey: true }),
      ),
    );
    expect(useLayoutStore.getState().assistantOpen).toBe(true);
  });
});
