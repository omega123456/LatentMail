import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Toast } from '@/components/states/Toast';
import { MAX_VISIBLE_TOASTS, useToastStore } from '@/stores/toast';

const show = (raise: () => void) => act(raise);

const rails = () => screen.getAllByTestId('toast-rail');
const viewport = () => screen.getByRole('region', { name: /notifications/i });

beforeEach(() => act(() => useToastStore.setState({ toasts: [] })));
afterEach(() => {
  act(() => useToastStore.setState({ toasts: [] }));
  vi.useRealTimers();
});

describe('Toast', () => {
  it('keeps the live region mounted while the queue is empty', () => {
    render(<Toast />);
    expect(viewport()).toBeInTheDocument();
    expect(screen.queryByTestId('toast-rail')).not.toBeInTheDocument();
  });

  it('announces errors assertively and confirmations politely', async () => {
    render(<Toast />);
    show(() => useToastStore.getState().showSuccess('Message sent.'));
    show(() => useToastStore.getState().showError('Couldn’t send your message.'));

    expect(await screen.findByText('Message sent.')).toBeInTheDocument();
    const politeness = screen
      .getAllByRole('status')
      .map((region) => region.getAttribute('aria-live'));
    expect(politeness).toContain('polite');
    expect(politeness).toContain('assertive');
  });

  it('dismisses the toast the close button belongs to', async () => {
    const user = userEvent.setup();
    render(<Toast />);
    show(() => useToastStore.getState().showSuccess('Label renamed.'));
    show(() => useToastStore.getState().showError('Couldn’t update conversation.'));

    await user.click((await screen.findAllByLabelText('Dismiss'))[0]!);
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
        'Couldn’t update conversation.',
      ]),
    );
    expect(screen.queryByText('Label renamed.')).not.toBeInTheDocument();
  });

  it('renders no more than the visible cap, keeping the newest', async () => {
    render(<Toast />);
    for (let index = 0; index <= MAX_VISIBLE_TOASTS; index += 1) {
      show(() => useToastStore.getState().showError(`Failure ${index}`));
    }
    await waitFor(() => expect(rails()).toHaveLength(MAX_VISIBLE_TOASTS));
    expect(screen.queryByText('Failure 0')).not.toBeInTheDocument();
    expect(screen.getByText(`Failure ${MAX_VISIBLE_TOASTS}`)).toBeInTheDocument();
  });

  it('holds the countdown rail while the viewport is hovered and resumes after', async () => {
    render(<Toast />);
    show(() => useToastStore.getState().showError('Couldn’t send your message.'));
    await waitFor(() => expect(rails()[0]).toHaveClass('animate-toast-error'));

    act(() => void fireEvent.pointerMove(viewport()));
    await waitFor(() => expect(rails()[0]).toHaveClass('animate-toast-error-hold'));

    act(() => void fireEvent.pointerLeave(viewport()));
    await waitFor(() => expect(rails()[0]).toHaveClass('animate-toast-error'));
  });

  it('clears a confirmation on its own well before an error', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(<Toast />);
    show(() => useToastStore.getState().showError('Couldn’t send your message.'));
    show(() => useToastStore.getState().showSuccess('Message sent.'));
    await waitFor(() => expect(rails()).toHaveLength(2));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    await waitFor(() =>
      expect(useToastStore.getState().toasts.map((toast) => toast.message)).toEqual([
        'Couldn’t send your message.',
      ]),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(25_000);
    });
    await waitFor(() => expect(useToastStore.getState().toasts).toEqual([]));
  });
});
