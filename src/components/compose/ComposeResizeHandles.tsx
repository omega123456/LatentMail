import type { PointerEvent as ReactPointerEvent } from 'react';
import { COMPOSE_MIN_PX, type ComposeDimensions } from '@/stores/compose';

export { COMPOSE_MIN_PX };

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Top edge, left edge and top-left corner drag affordances. The panel is
 * anchored bottom-right via fixed `right`/`bottom` insets, so growing width
 * or height automatically grows up and to the left with no extra
 * repositioning math — native CSS resize would instead grow down-right and
 * push the panel off-screen (D9). There is no keyboard resize, matching
 * every other resizable pane in the app. */
export function ComposeResizeHandles({
  dimensions,
  onResize,
}: {
  dimensions: ComposeDimensions;
  onResize: (dimensions: ComposeDimensions) => void;
}) {
  const drag =
    (axis: 'width' | 'height' | 'both') => (event: ReactPointerEvent<HTMLButtonElement>) => {
      const originX = event.clientX;
      const originY = event.clientY;
      const start = dimensions;
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
  return (
    <>
      <button
        type="button"
        aria-label="Resize composer height"
        title="Resize composer height"
        onPointerDown={drag('height')}
        className="absolute inset-x-0 top-0 h-handle-hit cursor-row-resize focus-visible:outline-2 focus-visible:outline-primary"
      />
      <button
        type="button"
        aria-label="Resize composer width"
        title="Resize composer width"
        onPointerDown={drag('width')}
        className="absolute inset-y-0 left-0 w-handle-hit cursor-col-resize focus-visible:outline-2 focus-visible:outline-primary"
      />
      <button
        type="button"
        aria-label="Resize composer"
        title="Resize composer"
        onPointerDown={drag('both')}
        className="absolute left-0 top-0 size-handle-hit cursor-nwse-resize focus-visible:outline-2 focus-visible:outline-primary"
      />
    </>
  );
}
