import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TrustedSendersList } from '@/components/settings/TrustedSendersList';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';

const senders = [
  'alerts@monzo.com',
  'billing@acme-cloud.com',
  'connect@figma.com',
  'digest@substack.com',
  'hello@readwise.io',
  'invoices@hetzner.com',
  'mail@notion.so',
  'news@economist.com',
  'no-reply@github.com',
  'orders@bandcamp.com',
  'receipts@stripe.com',
  'team@linear.app',
];

function setSenders(allowedImageSenders: string[], alwaysLoadRemoteImages = false) {
  act(() => {
    useLayoutStore.setState({ allowedImageSenders, alwaysLoadRemoteImages });
  });
}

function visibleAddresses() {
  return screen
    .getAllByRole('button', { name: /^Remove / })
    .map((button) => button.getAttribute('aria-label')?.replace('Remove ', ''));
}

beforeEach(() => {
  ipc.reset();
  ipc.override('write_setting', () => undefined);
  useLayoutStore.setState({ allowedImageSenders: [], alwaysLoadRemoteImages: false });
});

afterEach(() => {
  act(() => {
    useLayoutStore.setState({ allowedImageSenders: [], alwaysLoadRemoteImages: false });
  });
});

describe('TrustedSendersList', () => {
  it('teaches where trust comes from when nothing has been trusted yet', () => {
    render(<TrustedSendersList />);
    expect(screen.getByText('No trusted senders yet')).toBeInTheDocument();
    expect(screen.queryByText(/of 0/)).not.toBeInTheDocument();
  });

  it('sorts alphabetically and pages at ten rows by default', () => {
    setSenders([...senders].reverse());
    render(<TrustedSendersList />);

    expect(visibleAddresses()).toEqual(senders.slice(0, 10));
    expect(screen.getByText('1–10 of 12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Prev' })).toBeDisabled();
  });

  it('walks pages and lands on the remainder', async () => {
    const user = userEvent.setup();
    setSenders(senders);
    render(<TrustedSendersList />);

    await user.click(screen.getByRole('button', { name: 'Next' }));

    expect(visibleAddresses()).toEqual(senders.slice(10));
    expect(screen.getByText('11–12 of 12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('filters case-insensitively on a trimmed substring and marks the match', async () => {
    const user = userEvent.setup();
    setSenders(senders);
    render(<TrustedSendersList />);

    await user.type(screen.getByRole('searchbox', { name: 'Filter trusted senders' }), '  STRIPE ');

    expect(visibleAddresses()).toEqual(['receipts@stripe.com']);
    expect(screen.getByText('1–1 of 1')).toBeInTheDocument();
    expect(within(screen.getByText('stripe').closest('span') as HTMLElement).getByText('stripe'))
      .toBeInTheDocument();
  });

  it('offers a way back out of a filter that matches nothing', async () => {
    const user = userEvent.setup();
    setSenders(senders);
    render(<TrustedSendersList />);
    const filter = screen.getByRole('searchbox', { name: 'Filter trusted senders' });

    await user.type(filter, 'ivanov');
    expect(screen.getByText('No senders match “ivanov”')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear filter' }));
    expect(filter).toHaveValue('');
    expect(visibleAddresses()).toEqual(senders.slice(0, 10));
  });

  it('snaps back to page one when a filter invalidates the current page', async () => {
    const user = userEvent.setup();
    setSenders(senders);
    render(<TrustedSendersList />);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.type(screen.getByRole('searchbox', { name: 'Filter trusted senders' }), 'com');

    expect(screen.getByText(/^1–/)).toBeInTheDocument();
    expect(visibleAddresses().length).toBeGreaterThan(0);
  });

  it('snaps back to page one when a removal empties the current page', async () => {
    const user = userEvent.setup();
    setSenders(senders.slice(0, 11));
    render(<TrustedSendersList />);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'Remove receipts@stripe.com' }));

    expect(useLayoutStore.getState().allowedImageSenders).not.toContain('receipts@stripe.com');
    expect(screen.getByText('1–10 of 10')).toBeInTheDocument();
  });

  it('honours a smaller page size and resets the page with it', async () => {
    const user = userEvent.setup();
    setSenders(senders);
    render(<TrustedSendersList />);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('combobox', { name: 'Rows per page' }));
    await user.click(await screen.findByRole('option', { name: '5 rows' }));

    expect(visibleAddresses()).toEqual(senders.slice(0, 5));
    expect(screen.getByText('1–5 of 12')).toBeInTheDocument();
  });

  it('keeps the list but makes it inert while always-load supersedes it', () => {
    setSenders(['receipts@stripe.com', 'team@linear.app'], true);
    render(<TrustedSendersList />);

    expect(screen.getByText('receipts@stripe.com')).toBeInTheDocument();
    expect(screen.getByText(/Your list is kept/)).toBeInTheDocument();
    expect(screen.getByText('receipts@stripe.com').closest('[inert]')).not.toBeNull();
  });
});
