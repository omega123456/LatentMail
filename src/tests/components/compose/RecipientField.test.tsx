import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import { RecipientField } from '@/components/compose/RecipientField';
import { useComposeStore } from '@/stores/compose';
import { ipc } from '@/tests/ipc-mock';

function renderField(fieldRole: 'to' | 'cc' | 'bcc' = 'to') {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      <RecipientField
        fieldRole={fieldRole}
        label="To"
        accountId="account-1"
        placeholder="Recipients"
      />
    </QueryClientProvider>,
  );
}

const openSession = () =>
  act(() => {
    useComposeStore.getState().open({
      id: 'session',
      mode: 'new',
      accountId: 'account-1',
      from: 'me@example.com',
      recipients: { to: [], cc: [], bcc: [] },
      subject: '',
      html: '',
    });
  });

beforeEach(() => {
  act(() => useComposeStore.getState().close());
  openSession();
});

describe('RecipientField', () => {
  it('commits typed text on Enter, strips a trailing comma via comma-key commit, and supports Tab/blur commit', async () => {
    const user = userEvent.setup();
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    await user.type(input, 'priya@example.com{Enter}');
    expect(useComposeStore.getState().session?.recipients.to).toEqual(['priya@example.com']);

    await user.type(input, 'tomas@example.com,');
    expect(useComposeStore.getState().session?.recipients.to).toEqual([
      'priya@example.com',
      'tomas@example.com',
    ]);

    await user.type(input, 'ops@example.com');
    await user.tab();
    expect(useComposeStore.getState().session?.recipients.to).toEqual([
      'priya@example.com',
      'tomas@example.com',
      'ops@example.com',
    ]);
  });

  it('removes the last chip on Backspace when the input is empty', async () => {
    const user = userEvent.setup();
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    await user.type(input, 'a@example.com{Enter}');
    await user.type(input, 'b@example.com{Enter}');
    await user.type(input, '{Backspace}');
    expect(useComposeStore.getState().session?.recipients.to).toEqual(['a@example.com']);
  });

  it('treats a bare address and the same address with a display name as one recipient', async () => {
    const user = userEvent.setup();
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    await user.type(input, 'Priya Raman <priya@example.com>{Enter}');
    await user.type(input, 'PRIYA@example.com{Enter}');
    expect(useComposeStore.getState().session?.recipients.to).toEqual([
      'Priya Raman <priya@example.com>',
    ]);
    expect(screen.getAllByText('Priya Raman')).toHaveLength(1);
  });

  it('removes a chip via its labelled remove control', async () => {
    const user = userEvent.setup();
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    await user.type(input, 'a@example.com{Enter}');
    await user.click(screen.getByRole('button', { name: 'Remove a@example.com' }));
    expect(useComposeStore.getState().session?.recipients.to).toEqual([]);
  });

  it('queries contact suggestions after two characters, debounced, and shows named/address-only rows', async () => {
    const user = userEvent.setup();
    ipc.override('lookup_contacts', [
      { address: 'marta.oliveira@example.com', displayName: 'Marta Oliveira' },
      { address: 'marketing@example.com', displayName: null },
    ]);
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    await user.type(input, 'm');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.type(input, 'a');
    expect(await screen.findByText('Marta Oliveira')).toBeInTheDocument();
    expect(screen.getByText('marta.oliveira@example.com')).toBeInTheDocument();
    expect(screen.getByText('marketing@example.com')).toBeInTheDocument();
  });

  it('selects a suggestion with Enter after arrowing to it, committing the recipient', async () => {
    const user = userEvent.setup();
    ipc.override('lookup_contacts', [
      { address: 'marta.oliveira@example.com', displayName: 'Marta Oliveira' },
      { address: 'marcus.bell@example.com', displayName: 'Marcus Bell' },
    ]);
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    await user.type(input, 'ma');
    await screen.findByText('Marta Oliveira');
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(useComposeStore.getState().session?.recipients.to).toEqual([
        'Marcus Bell <marcus.bell@example.com>',
      ]),
    );
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('dismisses the suggestion popover on Escape without closing anything above it', async () => {
    const user = userEvent.setup();
    ipc.override('lookup_contacts', [
      { address: 'marta.oliveira@example.com', displayName: 'Marta Oliveira' },
    ]);
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    await user.type(input, 'ma');
    await screen.findByText('Marta Oliveira');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());

    expect(input).toHaveValue('ma');
  });

  it('reports the hidden count via the store as chips overflow three rows, driven by the ResizeObserver harness', async () => {
    const user = userEvent.setup();
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    for (const address of ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com', 'e@x.com']) {
      await user.type(input, `${address}{Enter}`);
    }
    expect(useComposeStore.getState().session?.overflow.to).toBe(0);

    act(() => {
      window.__resizeObserverInstances__?.forEach((instance) =>
        instance.callback(
          [{ contentRect: { height: 90 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
    });
    expect(screen.queryByRole('button', { name: /more recipient/ })).not.toBeInTheDocument();

    act(() => {
      window.__resizeObserverInstances__?.forEach((instance) =>
        instance.callback(
          [{ contentRect: { height: 96 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
    });
    expect(screen.queryByRole('button', { name: /more recipient/ })).not.toBeInTheDocument();

    act(() => {
      window.__resizeObserverInstances__?.forEach((instance) =>
        instance.callback(
          [{ contentRect: { height: 97 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
    });
    expect(
      await screen.findByRole('button', { name: '1 more recipient hidden' }),
    ).toBeInTheDocument();
    await waitFor(() => expect(useComposeStore.getState().session?.overflow.to).toBe(1));
  });

  it('re-shows every chip once the overflow control is activated', async () => {
    const user = userEvent.setup();
    renderField();
    const input = screen.getByRole('combobox', { name: 'To' });
    for (const address of ['a@x.com', 'b@x.com']) {
      await user.type(input, `${address}{Enter}`);
    }
    act(() => {
      window.__resizeObserverInstances__?.forEach((instance) =>
        instance.callback(
          [{ contentRect: { height: 97 } } as ResizeObserverEntry],
          {} as ResizeObserver,
        ),
      );
    });
    const overflow = await screen.findByRole('button', { name: /more recipient/ });
    await user.click(overflow);
    expect(screen.queryByRole('button', { name: /more recipient/ })).not.toBeInTheDocument();
    expect(screen.getByText('b@x.com')).toBeInTheDocument();
  });
});
