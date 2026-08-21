import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { getTime, parseISO } from 'date-fns';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsSection } from '@/components/settings/LogsSection';
import { renderWithQueryClient } from '@/tests/render-with-query-client';
import { ipc } from '@/tests/ipc-mock';
import { useLayoutStore } from '@/stores/layout';

const entries = [
  {
    timestampMillis: getTime(parseISO('2026-08-19T09:41:22.118Z')),
    level: 'ERROR',
    message: 'sync: history sync failed for alex@example.com',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-19T09:38:04.219Z')),
    level: 'INFO',
    message: 'sync: applied 14 history records',
  },
  {
    timestampMillis: getTime(parseISO('2026-08-19T09:37:51.880Z')),
    level: 'DEBUG',
    message: 'auth: access token refreshed',
  },
];

function manyEntries(count: number) {
  const base = getTime(parseISO('2026-08-19T09:00:00.000Z'));
  return Array.from({ length: count }, (_unused, index) => ({
    timestampMillis: base - index * 1_000,
    level: 'INFO',
    message: `entry number ${index}`,
  }));
}

describe('LogsSection', () => {
  beforeEach(() => {
    act(() => {
      useLayoutStore.setState({ logLevel: 'info' });
    });
  });

  it('renders entries newest-first', async () => {
    ipc.override('read_log_entries', entries);
    renderWithQueryClient(<LogsSection />);

    const messages = await screen.findAllByText(
      /sync: history sync failed|sync: applied|auth: access token/,
    );
    expect(messages.map((node) => node.textContent)).toEqual([
      'sync: history sync failed for alex@example.com',
      'sync: applied 14 history records',
      'auth: access token refreshed',
    ]);
  });

  it('shows the loading state before entries resolve', () => {
    ipc.override('read_log_entries', () => new Promise(() => undefined));
    renderWithQueryClient(<LogsSection />);
    expect(screen.getByText('Loading log entries…')).toBeInTheDocument();
  });

  it('shows the empty state when the log has no entries', async () => {
    ipc.override('read_log_entries', []);
    renderWithQueryClient(<LogsSection />);
    expect(await screen.findByText('No log entries found.')).toBeInTheDocument();
  });

  it('narrows by search text', async () => {
    const user = userEvent.setup();
    ipc.override('read_log_entries', entries);
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('auth: access token refreshed');

    await user.type(screen.getByRole('searchbox', { name: 'Search log entries' }), 'refreshed');

    expect(screen.getByText(/auth: access token/)).toBeInTheDocument();
    expect(screen.queryByText(/sync: applied/)).not.toBeInTheDocument();
  });

  it('shows the filtered-empty state when search matches nothing', async () => {
    const user = userEvent.setup();
    ipc.override('read_log_entries', entries);
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('auth: access token refreshed');

    await user.type(
      screen.getByRole('searchbox', { name: 'Search log entries' }),
      'nothing matches this',
    );

    expect(await screen.findByText('No entries match your search.')).toBeInTheDocument();
  });

  it('narrows by the level filter', async () => {
    const user = userEvent.setup();
    ipc.override('read_log_entries', entries);
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('auth: access token refreshed');

    await user.click(screen.getByRole('combobox', { name: 'Filter by level' }));
    await user.click(await screen.findByRole('option', { name: 'Debug' }));

    expect(screen.getByText('auth: access token refreshed')).toBeInTheDocument();
    expect(screen.queryByText(/sync: applied/)).not.toBeInTheDocument();
  });

  it('re-invokes read_log_entries when Refresh is clicked', async () => {
    const user = userEvent.setup();
    const read = vi.fn(() => entries);
    ipc.override('read_log_entries', read);
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('auth: access token refreshed');

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
  });

  it('persists the retained log level through write_setting', async () => {
    const user = userEvent.setup();
    const write = vi.fn();
    ipc.override('read_log_entries', entries);
    ipc.override('write_setting', write);
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('auth: access token refreshed');

    await user.click(screen.getByRole('combobox', { name: 'Application log level' }));
    await user.click(await screen.findByRole('option', { name: 'Debug' }));

    await waitFor(() => expect(write).toHaveBeenCalledWith({ key: 'logLevel', value: 'debug' }));
    expect(useLayoutStore.getState().logLevel).toBe('debug');
  });

  it('auto-refreshes every 5 seconds while the page stays visible', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.fn(() => entries);
    ipc.override('read_log_entries', read);
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('auth: access token refreshed');
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    vi.useRealTimers();
  });

  it('does not auto-refresh while the page is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const read = vi.fn(() => entries);
    ipc.override('read_log_entries', read);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('auth: access token refreshed');
    expect(read).toHaveBeenCalledTimes(1);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(read).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('paginates at 50 entries per page and resets to page 1 on a new search', async () => {
    const user = userEvent.setup();
    ipc.override('read_log_entries', manyEntries(60));
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('entry number 0');

    expect(screen.getByTestId('log-page-summary')).toHaveTextContent('1–50 of 60 entries');
    expect(screen.queryByText('entry number 50')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('entry number 50')).toBeInTheDocument();
    expect(screen.getByTestId('log-page-summary')).toHaveTextContent('51–60 of 60 entries');
    expect(screen.queryByText('entry number 0')).not.toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: 'Search log entries' }), 'number 0');
    expect(screen.getByTestId('log-page-summary')).toHaveTextContent('1–1 of 1 entries');
    expect(screen.getByText(/entry/)).toBeInTheDocument();
  });

  it('shows when the log was last updated and that it auto-refreshes', async () => {
    ipc.override('read_log_entries', entries);
    renderWithQueryClient(<LogsSection />);
    await screen.findByText('auth: access token refreshed');

    expect(await screen.findByText(/Last updated .* auto-refreshes every 5s/)).toBeInTheDocument();
    expect(screen.queryByText(/Snapshot taken/)).not.toBeInTheDocument();
  });

  it('copies a clicked row to the clipboard', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
    ipc.override('read_log_entries', entries);
    renderWithQueryClient(<LogsSection />);
    const row = await screen.findByText('auth: access token refreshed');

    await user.click(row.closest('button') as HTMLElement);

    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const [copied] = writeText.mock.calls[0] as [string];
    expect(copied).toContain('DEBUG auth: access token refreshed');
  });
});
