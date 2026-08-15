import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { ipc } from '@/tests/ipc-mock';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

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
// jsdom implements no Notification API, and in the app `window.Notification`
// is the Tauri notification plugin's injected shim rather than the browser's
// own — so it is polyfilled here, shaped like that shim (constructor +
// readable `permission` + `requestPermission`). Tests assert new-mail
// notifications through `window.__notifications__`.
declare global {
  interface Window {
    __notifications__?: { title: string; body?: string }[];
  }
}
// Re-installed per test rather than stubbed once: a suite that calls
// `vi.unstubAllGlobals()` would otherwise strip it for every suite after it.
function installNotificationStub() {
  window.__notifications__ = [];
  vi.stubGlobal(
    'Notification',
    Object.assign(
      class {
        constructor(title: string, options?: NotificationOptions) {
          window.__notifications__?.push({ title, body: options?.body });
        }
      },
      {
        permission: 'granted' as NotificationPermission,
        requestPermission: vi.fn(async (): Promise<NotificationPermission> => 'granted'),
      },
    ),
  );
}
installNotificationStub();
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
  configurable: true,
  value: () => ({
    bottom: 0,
    height: 0,
    left: 0,
    right: 0,
    toJSON: () => ({}),
    top: 0,
    width: 0,
    x: 0,
    y: 0,
  }),
});
const emptyClientRects = {
  length: 0,
  item: () => null,
  [Symbol.iterator]: function* () {},
} as unknown as DOMRectList;
HTMLElement.prototype.getClientRects = () => emptyClientRects;
Element.prototype.getClientRects = () => emptyClientRects;
Range.prototype.getClientRects = () => emptyClientRects;
// ProseMirror's `scrollIntoView` (fired after focus/selection changes) reads
// a `Range`'s bounding rect to compute scroll coordinates; jsdom's `Range`
// has no `getBoundingClientRect` at all, which otherwise surfaces as an
// unhandled async `TypeError` once a test drives real editor selection
// (e.g. clicking inside body text) rather than only the imperative ref API.
Range.prototype.getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
document.elementFromPoint = () => null;
Object.assign(navigator, { clipboard: { readText: vi.fn(), writeText: vi.fn() } });
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
  installNotificationStub();
});
// Unmount, don't just wipe the DOM: clearing `innerHTML` leaves the previous
// test's React tree mounted and still subscribed to the Zustand stores, so it
// keeps reacting to (and fighting over) state the next test sets up.
afterEach(cleanup);
