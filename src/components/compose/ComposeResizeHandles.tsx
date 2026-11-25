import type { PointerEvent as ReactPointerEvent } from 'react';
import { COMPOSE_MIN_PX, type ComposeDimensions } from '@/stores/compose';

export { COMPOSE_MIN_PX };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

type ResizeAxis = 'width' | 'height' | 'both';

function beginComposeResize(
  axis: ResizeAxis,
  start: ComposeDimensions,
  onResize: (dimensions: ComposeDimensions) => void,
) {
  return (event: ReactPointerEvent<HTMLButtonElement>) => {
    const originX = event.clientX;
    const originY = event.clientY;
    const move = (moveEvent: PointerEvent) => {
      const next = { ...start };
      if (axis === 'width' || axis === 'both') {
        next.width = clamp(
          start.width - (moveEvent.clientX - originX),
          COMPOSE_MIN_PX,
          window.innerWidth,
        );
      }
      if (axis === 'height' || axis === 'both') {
        next.height = clamp(
          start.height - (moveEvent.clientY - originY),
          COMPOSE_MIN_PX,
          window.innerHeight,
        );
      }
      onResize(next);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
}

export function ComposeResizeHandles({
  dimensions,
  onResize,
}: {
  dimensions: ComposeDimensions;
  onResize: (dimensions: ComposeDimensions) => void;
}) {
  return (
    <>
      <button
        type="button"
        aria-label="Resize composer height"
        title="Resize composer height"
        onPointerDown={beginComposeResize('height', dimensions, onResize)}
        className="absolute inset-x-0 top-0 h-handle-hit cursor-row-resize focus-visible:outline-2 focus-visible:outline-primary"
      />
      <button
        type="button"
        aria-label="Resize composer width"
        title="Resize composer width"
        onPointerDown={beginComposeResize('width', dimensions, onResize)}
        className="absolute inset-y-0 left-0 w-handle-hit cursor-col-resize focus-visible:outline-2 focus-visible:outline-primary"
      />
      <button
        type="button"
        aria-label="Resize composer"
        title="Resize composer"
        onPointerDown={beginComposeResize('both', dimensions, onResize)}
        className="absolute left-0 top-0 size-handle-hit cursor-nwse-resize focus-visible:outline-2 focus-visible:outline-primary"
      />
    </>
  );
}
