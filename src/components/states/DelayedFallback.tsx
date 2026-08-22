import { lazy, useEffect, useState, type ComponentType, type ReactNode } from 'react';

const fallbackDelay = 200;
const fallbackMinimum = 300;

export function lazyWithDelayedFallback<T extends ComponentType<Record<string, never>>>(
  load: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    let delayed = false;
    const timer = new Promise<void>((resolve) =>
      setTimeout(() => {
        delayed = true;
        resolve();
      }, fallbackDelay),
    );
    const component = await load();
    if (!delayed) return component;
    await timer;
    await new Promise<void>((resolve) => setTimeout(resolve, fallbackMinimum));
    return component;
  });
}

export function DelayedFallback({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timeout = setTimeout(() => setVisible(true), fallbackDelay);
    return () => clearTimeout(timeout);
  }, []);

  return visible ? children : null;
}
