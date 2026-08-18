import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { KeyboardSection } from '@/components/settings/KeyboardSection';
import { CommandProvider } from '@/providers/CommandProvider';
import { ipc } from '@/tests/ipc-mock';

describe('KeyboardSection', () => {
  beforeEach(() => ipc.reset());

  it('lists every registered command with label, description and keycaps', async () => {
    render(
      <CommandProvider>
        <KeyboardSection />
      </CommandProvider>,
    );

    expect(screen.getByTestId('shortcut-row-replyAllToMessage')).toBeInTheDocument();
    expect(screen.getByText('Reply all')).toBeInTheDocument();
    expect(screen.getByText('Reply to everyone on the thread.')).toBeInTheDocument();
    expect(screen.getByText('Not set')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reset all' })).not.toBeInTheDocument(),
    );
  });

  it('shows Reset all only while at least one override exists', async () => {
    ipc.override('read_settings', {
      theme: 'system',
      layout: 'three-column',
      density: 'comfortable',
      sidebarCollapsed: false,
      sidebarWidth: 260,
      listWidth: 350,
      readerHeight: 40,
      syncOnStartup: true,
      showUnreadCounts: true,
      syncIntervalSeconds: 300,
      showSenderAvatars: true,
      zoomPercent: 100,
      commandOverrides: {},
    });

    render(
      <CommandProvider>
        <KeyboardSection />
      </CommandProvider>,
    );

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reset all' })).not.toBeInTheDocument(),
    );
  });

  it('rebinding a command through the section writes an override and shows Reset all', async () => {
    const user = userEvent.setup();
    const writes: Array<{ key: string; value: unknown }> = [];
    ipc.override('write_setting', (args) => {
      writes.push(args as { key: string; value: unknown });
    });

    render(
      <CommandProvider>
        <KeyboardSection />
      </CommandProvider>,
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Reset all' })).not.toBeInTheDocument(),
    );

    await user.click(screen.getByRole('button', { name: 'Change shortcut for Reply all' }));
    const field = screen.getByRole('textbox');
    field.focus();
    await user.keyboard('n');
    await user.click(screen.getByRole('button', { name: 'Apply' }));

    expect(writes).toContainEqual({
      key: 'commandOverrides',
      value: { replyAllToMessage: ['n', 'N'] },
    });
    expect(screen.getByRole('button', { name: 'Reset all' })).toBeInTheDocument();
  });

  it('cancelling a capture from the section returns the row to its keycaps', async () => {
    const user = userEvent.setup();
    render(
      <CommandProvider>
        <KeyboardSection />
      </CommandProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Change shortcut for Reply all' }));
    expect(screen.getByRole('textbox')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(
      screen.getByRole('button', { name: 'Change shortcut for Reply all' }),
    ).toBeInTheDocument();
  });
});
