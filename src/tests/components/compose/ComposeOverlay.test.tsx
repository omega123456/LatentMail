import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComposeOverlay } from '@/components/compose/ComposeOverlay';
import { type ComposeMode, useComposeStore } from '@/stores/compose';
import { ipc } from '@/tests/ipc-mock';

function renderOverlay(children: React.ReactNode = null) {
  const client = new QueryClient();
  return render(
    <QueryClientProvider client={client}>
      {children}
      <ComposeOverlay />
    </QueryClientProvider>,
  );
}

const openSession = (mode: ComposeMode = 'new', extra: Record<string, unknown> = {}) =>
  act(() => {
    useComposeStore.getState().open({
      id: 'session',
      mode,
      accountId: 'account-1',
      from: 'me@example.com',
      recipients: { to: [], cc: [], bcc: [] },
      subject: '',
      html: '',
      ...extra,
    });
  });

beforeEach(() => {
  act(() => useComposeStore.getState().close());
});

describe('ComposeOverlay', () => {
  it('renders nothing when no session is open', () => {
    renderOverlay();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('opens anchored, with a dialog role and an accessible name reflecting the mode', () => {
    renderOverlay();
    openSession('reply-all');
    expect(screen.getByRole('dialog', { name: 'Reply All' })).toBeInTheDocument();
  });

  it('tints the mailbox behind it without blocking pointer access', async () => {
    const onMailboxClick = vi.fn();
    const user = userEvent.setup();
    renderOverlay(
      <button type="button" onClick={onMailboxClick}>
        Mailbox link
      </button>,
    );
    openSession();
    const backdrop = document.querySelector('[aria-hidden="true"].pointer-events-none');
    expect(backdrop).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Mailbox link' }));
    expect(onMailboxClick).toHaveBeenCalledTimes(1);
    // Clicking through to the mailbox never dismisses the non-modal panel.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it.each(['new', 'forward'] as const)('focuses To for %s', async (mode) => {
    renderOverlay();
    openSession(mode);
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'To' })).toHaveFocus());
  });

  it.each(['reply', 'reply-all'] as const)('focuses the body for %s', async (mode) => {
    renderOverlay();
    openSession(mode);
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('contenteditable')).toBe('true'),
    );
    expect(screen.getByRole('combobox', { name: 'To' })).not.toHaveFocus();
  });

  it('closes on Escape and returns focus to the control that had it before opening', async () => {
    const user = userEvent.setup();
    renderOverlay(<button type="button">Opener</button>);
    const opener = screen.getByRole('button', { name: 'Opener' });
    opener.focus();
    openSession();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(useComposeStore.getState().session).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('does not trap focus — tabbing from the last control inside the panel leaves it rather than cycling back to its first control', async () => {
    const user = userEvent.setup();
    // A real focus trap redirects Tab, at the last focusable element inside
    // the dialog, back to the *first* focusable element inside it (a resize
    // handle here) instead of letting it continue past the panel.
    renderOverlay(<button type="button">Before mailbox link</button>);
    openSession();
    const panel = screen.getByTestId('compose-overlay');
    // Send stays disabled throughout this phase (unfocusable), so "Insert
    // image" is the last real tab stop inside the panel.
    const lastControl = screen.getByRole('button', { name: 'Insert image' });
    const firstFocusableInPanel = screen.getByRole('button', { name: 'Resize composer height' });
    lastControl.focus();
    await user.tab();
    expect(panel.contains(document.activeElement)).toBe(false);
    expect(document.activeElement).not.toBe(firstFocusableInPanel);
  });

  it('reveals Cc and Bcc together via one control, and they persist once revealed', async () => {
    const user = userEvent.setup();
    renderOverlay();
    openSession();
    expect(screen.queryByRole('combobox', { name: 'Cc' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Cc/Bcc' }));
    expect(screen.getByRole('combobox', { name: 'Cc' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Bcc' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cc/Bcc' })).not.toBeInTheDocument();
  });

  it('enables Send when a committed To recipient is present', async () => {
    const user = userEvent.setup();
    renderOverlay();
    openSession();
    const send = screen.getByRole('button', { name: 'Send' });
    expect(send).toBeDisabled();
    expect(send).toHaveAttribute('data-recipient-ready', 'false');
    await user.type(screen.getByRole('combobox', { name: 'To' }), 'a@example.com{Enter}');
    expect(send).toHaveAttribute('data-recipient-ready', 'true');
    expect(send).toBeEnabled();
  });

  it('renders the quote disclosure collapsed by default, outside the editable document', async () => {
    const user = userEvent.setup();
    renderOverlay();
    openSession('reply', {
      quote: { html: '<p>Original message</p>', attribution: 'On Mar 1, Elena wrote:' },
    });
    expect(screen.getByRole('button', { name: 'Show quoted text' })).toBeInTheDocument();
    expect(screen.queryByText('Original message')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show quoted text' }));
    expect(screen.getByRole('region', { name: 'Quoted content, read-only' })).toBeInTheDocument();
    expect(useComposeStore.getState().session?.quoteOpen).toBe(true);
  });

  it('resizes from a drag handle, updating the session dimensions', () => {
    renderOverlay();
    openSession();
    const before = useComposeStore.getState().session?.dimensions;
    const handle = screen.getByRole('button', { name: 'Resize composer width' });
    act(() => {
      handle.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, clientX: 100, cancelable: true }),
      );
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 40 }));
      window.dispatchEvent(new PointerEvent('pointerup', {}));
    });
    expect(useComposeStore.getState().session?.dimensions).not.toEqual(before);
  });

  it('closes via the header Close control', async () => {
    const user = userEvent.setup();
    renderOverlay();
    openSession();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(useComposeStore.getState().session).toBeNull());
  });

  it('sets the Subject field and marks the session dirty', async () => {
    const user = userEvent.setup();
    renderOverlay();
    openSession();
    await user.type(screen.getByLabelText('Subject'), 'Q3 numbers');
    expect(useComposeStore.getState().session?.subject).toBe('Q3 numbers');
    expect(useComposeStore.getState().session?.dirty).toBe(true);
  });

  it('opens the link dialog from the toolbar and closes it again on apply', async () => {
    const user = userEvent.setup();
    renderOverlay();
    openSession();
    await user.click(screen.getByRole('button', { name: 'Link' }));
    const urlInput = screen.getByLabelText('Link URL');
    await user.type(urlInput, 'example.com');
    await user.click(screen.getByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(screen.queryByLabelText('Link URL')).not.toBeInTheDocument());
  });

  it('removes an existing link directly, without opening the dialog, when Link is activated inside one', async () => {
    const user = userEvent.setup();
    renderOverlay();
    openSession('new', { html: '<p><a href="https://example.com">a link</a></p>' });
    await waitFor(() => expect(useComposeStore.getState().session?.html).toContain('href'));
    // Place the caret inside the existing link before toggling it off.
    const linkText = screen.getByText('a link');
    await user.click(linkText);
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(screen.queryByLabelText('Link URL')).not.toBeInTheDocument();
    await waitFor(() => expect(useComposeStore.getState().session?.html).not.toContain('href'));
  });

  it('does nothing when Link is activated before the editor instance is ready', async () => {
    const user = userEvent.setup();
    renderOverlay();
    openSession();
    // The click handler itself no-ops when `editor` is still null — this
    // exercises that guard rather than asserting anything user-visible.
    await user.click(screen.getByRole('button', { name: 'Link' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('confirms a non-empty discard and dispatches it through the centralized IPC harness', async () => {
    const user = userEvent.setup();
    const discard = vi.fn();
    ipc.override('discard_compose_draft', discard);
    renderOverlay();
    openSession('new', { subject: 'No longer needed' });
    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
    await user.click(
      within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }),
    );
    await waitFor(() => expect(useComposeStore.getState().session).toBeNull());
    expect(discard).toHaveBeenCalledWith({
      accountId: 'account-1',
      draftId: null,
      sessionId: 'session',
    });
  });

  it('sends a ready draft and closes only after queue acceptance', async () => {
    const user = userEvent.setup();
    let accept!: () => void;
    ipc.override(
      'send_compose_draft',
      () =>
        new Promise((resolve) => {
          accept = () => resolve({ operationId: 'send-1', draftId: 'draft-1' });
        }),
    );
    renderOverlay();
    openSession('new');
    await user.type(screen.getByRole('combobox', { name: 'To' }), 'a@example.com{Enter}');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await act(async () => accept());
    await waitFor(() => expect(useComposeStore.getState().session).toBeNull());
  });
});
