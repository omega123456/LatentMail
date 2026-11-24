import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

type Orientation = 'vertical' | 'horizontal';

function pointerOffset(orientation: Orientation, event: { clientX: number; clientY: number }) {
  return orientation === 'vertical' ? event.clientX : event.clientY;
}

export function ResizeHandle({
  ariaLabel,
  orientation,
  onResize,
}: {
  ariaLabel: string;
  orientation: Orientation;
  onResize: (offset: number) => void;
}) {
  const stopDraggingRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopDraggingRef.current?.(), []);

  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    stopDraggingRef.current?.();
    const origin = pointerOffset(orientation, event);
    const move = (moveEvent: PointerEvent) =>
      onResize(pointerOffset(orientation, moveEvent) - origin);
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      stopDraggingRef.current = null;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    stopDraggingRef.current = stop;
  };
  return (
    <button
      aria-label={ariaLabel}
      onPointerDown={start}
      className={`${orientation === 'vertical' ? 'w-pane-gap cursor-col-resize before:absolute before:-inset-x-1 before:inset-y-0' : 'h-pane-gap cursor-row-resize before:absolute before:inset-x-0 before:-inset-y-1'} group relative z-10 shrink-0 bg-outline-variant focus-visible:outline-2 focus-visible:outline-primary dark:bg-dark-outline-variant`}
    />
  );
}
