import { act } from '@testing-library/react';

export function closestOrThrow(element: Element, selector: string): Element {
  const ancestor = element.closest(selector);
  if (!ancestor) throw new Error(`expected an ancestor matching ${selector}`);
  return ancestor;
}

export function triggerResizeObservers(width: number, height = 0): void {
  const entry = { contentRect: { width: width, height: height } } as ResizeObserverEntry;
  act(() => {
    for (const observer of window.__resizeObserverInstances__ ?? []) {
      observer.callback([entry], observer as unknown as ResizeObserver);
    }
  });
}
