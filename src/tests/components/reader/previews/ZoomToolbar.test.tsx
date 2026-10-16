import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ZoomToolbar } from '@/components/reader/previews/ZoomToolbar';
import type { ZoomMode } from '@/lib/attachments/zoom';

function renderToolbar(zoom: number, mode: ZoomMode = 'custom') {
  const handlers = { onZoomIn: vi.fn(), onZoomOut: vi.fn(), onSelectPreset: vi.fn() };
  render(<ZoomToolbar zoom={zoom} mode={mode} leading="Page 2 of 5" {...handlers} />);
  return handlers;
}

describe('ZoomToolbar', () => {
  it('shows the leading text, the percentage and steps with the buttons', async () => {
    const user = userEvent.setup();
    const handlers = renderToolbar(1.25);
    expect(screen.getByText('Page 2 of 5')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Zoom level 125%' })).toHaveTextContent('125%');
    expect(screen.getByText('Zoom 125%')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    await user.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(handlers.onZoomIn).toHaveBeenCalledTimes(1);
    expect(handlers.onZoomOut).toHaveBeenCalledTimes(1);
  });

  it('dims but keeps focusable the button at each limit and announces it', () => {
    renderToolbar(4);
    expect(screen.getByRole('button', { name: 'Zoom in' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Zoom in' })).not.toBeDisabled();
    expect(screen.getByText('Maximum zoom, 400%')).toBeInTheDocument();
  });

  it('announces the minimum', () => {
    renderToolbar(0.5);
    expect(screen.getByRole('button', { name: 'Zoom out' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByText('Minimum zoom, 50%')).toBeInTheDocument();
  });

  it('checks the active fit mode and picks presets from the menu', async () => {
    const user = userEvent.setup();
    const handlers = renderToolbar(1.18, 'fit-width');
    await user.click(screen.getByRole('button', { name: 'Zoom level 118%' }));
    expect(await screen.findByRole('menuitemradio', { name: 'Fit width' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await user.click(screen.getByRole('menuitemradio', { name: '200%' }));
    expect(handlers.onSelectPreset).toHaveBeenCalledWith(2);

    await user.click(screen.getByRole('button', { name: 'Zoom level 118%' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Fit page' }));
    expect(handlers.onSelectPreset).toHaveBeenLastCalledWith('fit-page');
  });

  it('checks the matching step when a fixed zoom is active', async () => {
    const user = userEvent.setup();
    renderToolbar(1.5);
    await user.click(screen.getByRole('button', { name: 'Zoom level 150%' }));
    expect(await screen.findByRole('menuitemradio', { name: '150%' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });
});
