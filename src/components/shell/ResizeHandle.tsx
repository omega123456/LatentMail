import type { PointerEvent as ReactPointerEvent } from 'react';

export function ResizeHandle({
  ariaLabel,
  orientation,
  onResize,
}: {
  ariaLabel: string;
  orientation: 'vertical' | 'horizontal';
  onResize: (offset: number) => void;
}) {
  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const origin = orientation === 'vertical' ? event.clientX : event.clientY;
    const move = (moveEvent: PointerEvent) =>
      onResize((orientation === 'vertical' ? moveEvent.clientX : moveEvent.clientY) - origin);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return (
    <button
      aria-label={ariaLabel}
      onPointerDown={start}
      className={`${orientation === 'vertical' ? 'w-pane-gap cursor-col-resize before:absolute before:-inset-x-1 before:inset-y-0' : 'h-pane-gap cursor-row-resize before:absolute before:inset-x-0 before:-inset-y-1'} group relative z-10 shrink-0 bg-outline-variant focus-visible:outline-2 focus-visible:outline-primary dark:bg-dark-outline-variant`}
    />
  );
}
