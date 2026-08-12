import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { ipc } from '@/tests/ipc-mock';

vi.stubGlobal(
  'matchMedia',
  vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);
// Keeps every live instance's callback reachable at
// `window.__resizeObserverInstances__` so a test can simulate a resize (e.g.
// `ActionRibbon`'s overflow-width collapse) by invoking it directly — jsdom
// itself never fires real resize observations.
declare global {
  interface Window {
    __resizeObserverInstances__?: { callback: ResizeObserverCallback }[];
  }
}
window.__resizeObserverInstances__ = [];
vi.stubGlobal(
  'ResizeObserver',
  class {
    callback: ResizeObserverCallback;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      window.__resizeObserverInstances__?.push(this);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();
// jsdom has no Pointer Events implementation, so Radix primitives (which
// probe `hasPointerCapture`/`setPointerCapture`/`releasePointerCapture`
// before touch/mouse interactions) throw `TypeError: ... is not a function`
// without these stubs.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}

beforeEach(() => {
  ipc.reset();
  window.__resizeObserverInstances__ = [];
});
// Unmount, don't just wipe the DOM: clearing `innerHTML` leaves the previous
// test's React tree mounted and still subscribed to the Zustand stores, so it
// keeps reacting to (and fighting over) state the next test sets up.
afterEach(cleanup);
