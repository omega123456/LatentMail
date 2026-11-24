import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from '@/components/shell/ResizeHandle';

const MOVEMENT_AFTER_RELEASE = 10;

describe('ResizeHandle', () => {
  it.each([
    { orientation: 'vertical', axis: 'clientX', start: 10, end: 34 },
    { orientation: 'horizontal', axis: 'clientY', start: 20, end: 47 },
  ] as const)(
    'reports $orientation pointer movement and stops after release',
    ({ orientation, axis, start, end }) => {
      const onResize = vi.fn();
      render(<ResizeHandle ariaLabel="Resize" orientation={orientation} onResize={onResize} />);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize' }), { [axis]: start });
      fireEvent.pointerMove(window, { [axis]: end });
      fireEvent.pointerUp(window);
      fireEvent.pointerMove(window, { [axis]: end + MOVEMENT_AFTER_RELEASE });
      expect(onResize).toHaveBeenCalledTimes(1);
      expect(onResize).toHaveBeenCalledWith(end - start);
    },
  );

  it('stops reporting movement when the pointer is cancelled mid-drag', () => {
    const onResize = vi.fn();
    render(<ResizeHandle ariaLabel="Resize" orientation="vertical" onResize={onResize} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize' }), { clientX: 10 });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientX: 40 });
    expect(onResize).not.toHaveBeenCalled();
  });

  it('stops listening to the window when it unmounts mid-drag', () => {
    const onResize = vi.fn();
    const view = render(
      <ResizeHandle ariaLabel="Resize" orientation="vertical" onResize={onResize} />,
    );
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize' }), { clientX: 10 });
    view.unmount();
    fireEvent.pointerMove(window, { clientX: 40 });
    expect(onResize).not.toHaveBeenCalled();
  });
});
