import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { COMPOSE_MIN_PX, ComposeResizeHandles } from '@/components/compose/ComposeResizeHandles';

describe('ComposeResizeHandles', () => {
  const dimensions = { width: 512, height: 500 };

  it('grows height by dragging the top edge upward (bottom stays anchored)', () => {
    const onResize = vi.fn();
    render(<ComposeResizeHandles dimensions={dimensions} onResize={onResize} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize composer height' }), {
      clientY: 100,
    });
    fireEvent.pointerMove(window, { clientY: 60 });
    expect(onResize).toHaveBeenCalledWith({ width: 512, height: 540 });
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientY: 10 });
    expect(onResize).toHaveBeenCalledTimes(1);
  });

  it('grows width by dragging the left edge leftward (right stays anchored)', () => {
    const onResize = vi.fn();
    render(<ComposeResizeHandles dimensions={dimensions} onResize={onResize} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize composer width' }), {
      clientX: 100,
    });
    fireEvent.pointerMove(window, { clientX: 40 });
    expect(onResize).toHaveBeenCalledWith({ width: 572, height: 500 });
    fireEvent.pointerUp(window);
  });

  it('resizes both axes from the corner handle', () => {
    const onResize = vi.fn();
    render(<ComposeResizeHandles dimensions={dimensions} onResize={onResize} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize composer' }), {
      clientX: 100,
      clientY: 100,
    });
    fireEvent.pointerMove(window, { clientX: 70, clientY: 80 });
    expect(onResize).toHaveBeenCalledWith({ width: 542, height: 520 });
    fireEvent.pointerUp(window);
  });

  it('clamps to the shared minimum and to the viewport', () => {
    const onResize = vi.fn();
    render(<ComposeResizeHandles dimensions={dimensions} onResize={onResize} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize composer height' }), {
      clientY: 0,
    });
    // Dragging far down would shrink height below the shared minimum.
    fireEvent.pointerMove(window, { clientY: 100000 });
    expect(onResize).toHaveBeenLastCalledWith({ width: 512, height: COMPOSE_MIN_PX });
    fireEvent.pointerUp(window);

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize composer width' }), {
      clientX: 0,
    });
    // Dragging far right would shrink width below the shared minimum too.
    fireEvent.pointerMove(window, { clientX: 100000 });
    expect(onResize).toHaveBeenLastCalledWith({ width: COMPOSE_MIN_PX, height: 500 });
    fireEvent.pointerUp(window);
  });
});
