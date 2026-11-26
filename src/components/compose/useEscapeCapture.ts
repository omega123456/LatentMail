import { useEffect, useEffectEvent } from 'react';

export function useEscapeCapture(active: boolean, onEscape: () => void) {
  const handleEscape = useEffectEvent(onEscape);
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      handleEscape();
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [active]);
}
