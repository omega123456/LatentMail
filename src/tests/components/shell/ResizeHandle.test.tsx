import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ResizeHandle } from '@/components/shell/ResizeHandle';

describe('ResizeHandle', () => {
  it.each([
    ['vertical', 'clientX', 10, 34],
    ['horizontal', 'clientY', 20, 47],
  ] as const)(
    'reports %s pointer movement and stops after release',
    (orientation, axis, start, end) => {
      const onResize = vi.fn();
      render(<ResizeHandle ariaLabel="Resize" orientation={orientation} onResize={onResize} />);
      fireEvent.pointerDown(screen.getByRole('button', { name: 'Resize' }), { [axis]: start });
      fireEvent.pointerMove(window, { [axis]: end });
      fireEvent.pointerUp(window);
      fireEvent.pointerMove(window, { [axis]: end + 10 });
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
