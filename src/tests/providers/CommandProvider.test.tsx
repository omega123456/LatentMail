import { StrictMode } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { ipc } from '@/tests/ipc-mock';
import { DEFAULT_COMMAND_BINDINGS } from '@/lib/keyboard/registry';
import {
  CommandProvider,
  useClearAllCommandOverrides,
  useClearCommandOverride,
  useCommandBindings,
  useHasAnyCommandOverride,
  useSetCommandOverride,
} from '@/providers/CommandProvider';
import { captureConsole } from '@/tests/console';

const OVERRIDE_WRITES = 2;

it('is a harmless no-op to clear a single override or all overrides without a provider ancestor', () => {
  function ClearOverrides() {
    const clearOverride = useClearCommandOverride();
    const clearAllOverrides = useClearAllCommandOverrides();
    clearOverride('toggleStar');
    clearAllOverrides();
    return null;
  }
  expect(() => render(<ClearOverrides />)).not.toThrow();
});

function Bindings() {
  const bindings = useCommandBindings();
  return <span>{JSON.stringify(bindings)}</span>;
}

function Controls() {
  const bindings = useCommandBindings();
  const setOverride = useSetCommandOverride();
  const clearOverride = useClearCommandOverride();
  const clearAllOverrides = useClearAllCommandOverrides();
  const hasAnyOverride = useHasAnyCommandOverride();
  return (
    <div>
      <span data-testid="binding">{bindings.toggleStar.join(',')}</span>
      <span data-testid="has-any-override">{String(hasAnyOverride)}</span>
      <button onClick={() => setOverride('toggleStar', ['Mod+K'])}>set</button>
      <button onClick={() => clearOverride('toggleStar')}>reset one</button>
      <button onClick={() => clearAllOverrides()}>reset all</button>
    </div>
  );
}

it('resolves to the default bindings for a component rendered without a provider', () => {
  render(<Bindings />);
  expect(screen.getByText(JSON.stringify(DEFAULT_COMMAND_BINDINGS))).toBeInTheDocument();
});

it('still resolves the defaults when mounted, with no overrides set', async () => {
  render(
    <CommandProvider>
      <Bindings />
    </CommandProvider>,
  );
  await waitFor(() =>
    expect(screen.getByText(JSON.stringify(DEFAULT_COMMAND_BINDINGS))).toBeInTheDocument(),
  );
});

it('is a harmless no-op to set an override without a provider ancestor', () => {
  function SetOverride() {
    const setOverride = useSetCommandOverride();
    setOverride('toggleStar', ['Mod+K']);
    return null;
  }
  expect(() => render(<SetOverride />)).not.toThrow();
});

it('uses the shared settings read on mount', async () => {
  render(
    <CommandProvider>
      <Controls />
    </CommandProvider>,
  );

  await waitFor(() => expect(screen.getByTestId('has-any-override')).toHaveTextContent('false'));
});

it('persists a new override through write_setting', async () => {
  const user = userEvent.setup();
  const writes: Array<{ key: string; value: unknown }> = [];
  ipc.override('write_setting', (request) => {
    writes.push(request as { key: string; value: unknown });
  });

  render(
    <CommandProvider>
      <Controls />
    </CommandProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('has-any-override')).toHaveTextContent('false'));

  await user.click(screen.getByText('set'));

  expect(screen.getByTestId('binding')).toHaveTextContent('Mod+K');
  expect(writes).toContainEqual({ key: 'commandOverrides', value: { toggleStar: ['Mod+K'] } });
});

it('resetting a single command clears just its entry, and reset-all appears only while an override exists', async () => {
  const user = userEvent.setup();
  const writes: Array<{ key: string; value: unknown }> = [];
  ipc.override('write_setting', (request) => {
    writes.push(request as { key: string; value: unknown });
  });

  render(
    <CommandProvider>
      <Controls />
    </CommandProvider>,
  );
  await user.click(screen.getByText('set'));
  expect(screen.getByTestId('has-any-override')).toHaveTextContent('true');

  await user.click(screen.getByText('reset one'));

  await waitFor(() =>
    expect(screen.getByTestId('binding')).toHaveTextContent(
      DEFAULT_COMMAND_BINDINGS.toggleStar.join(','),
    ),
  );
  expect(screen.getByTestId('has-any-override')).toHaveTextContent('false');
  expect(writes).toContainEqual({ key: 'commandOverrides', value: {} });
});

it('clears every override in a single write', async () => {
  const user = userEvent.setup();
  const writes: Array<{ key: string; value: unknown }> = [];
  ipc.override('write_setting', (request) => {
    writes.push(request as { key: string; value: unknown });
  });

  render(
    <CommandProvider>
      <Controls />
    </CommandProvider>,
  );
  await user.click(screen.getByText('set'));
  expect(screen.getByTestId('has-any-override')).toHaveTextContent('true');

  await user.click(screen.getByText('reset all'));

  await waitFor(() => expect(screen.getByTestId('has-any-override')).toHaveTextContent('false'));
  expect(writes).toContainEqual({ key: 'commandOverrides', value: {} });
});

it('swallows a failed hydration read, leaving the defaults in place', async () => {
  const consoleError = captureConsole('error');
  ipc.override('read_settings', () => {
    throw new Error('boom');
  });

  render(
    <CommandProvider>
      <Bindings />
    </CommandProvider>,
  );

  await waitFor(() =>
    expect(screen.getByText(JSON.stringify(DEFAULT_COMMAND_BINDINGS))).toBeInTheDocument(),
  );
  expect(consoleError).toHaveBeenCalledWith('ipc read_settings failed: boom');
});

it('swallows a failed persist without throwing', async () => {
  const consoleError = captureConsole('error');
  const user = userEvent.setup();
  ipc.override('write_setting', () => {
    throw new Error('boom');
  });

  render(
    <CommandProvider>
      <Controls />
    </CommandProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('has-any-override')).toHaveTextContent('false'));

  await user.click(screen.getByText('set'));

  expect(screen.getByTestId('binding')).toHaveTextContent('Mod+K');
  expect(consoleError).toHaveBeenCalledWith('ipc write_setting failed: boom');
});

it('writes each override change exactly once, even when StrictMode replays state updaters', async () => {
  const user = userEvent.setup();
  const writes = vi.fn();
  ipc.override('write_setting', writes);
  render(
    <StrictMode>
      <CommandProvider>
        <Controls />
      </CommandProvider>
    </StrictMode>,
  );
  await user.click(screen.getByRole('button', { name: 'set' }));
  await waitFor(() => expect(screen.getByTestId('binding')).toHaveTextContent('Mod+K'));
  expect(writes).toHaveBeenCalledTimes(1);
  expect(writes).toHaveBeenLastCalledWith({
    key: 'commandOverrides',
    value: { toggleStar: ['Mod+K'] },
  });

  await user.click(screen.getByRole('button', { name: 'reset one' }));
  await waitFor(() => expect(screen.getByTestId('has-any-override')).toHaveTextContent('false'));
  expect(writes).toHaveBeenCalledTimes(OVERRIDE_WRITES);
  expect(writes).toHaveBeenLastCalledWith({ key: 'commandOverrides', value: {} });
});
