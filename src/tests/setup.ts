import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { ipc } from '@/tests/ipc-mock';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
Object.assign(window, {
  __TAURI_OS_PLUGIN_INTERNALS__: {
    eol: '\n',
    os_type: 'macos',
    platform: 'macos',
    family: 'unix',
    version: '',
    arch: 'aarch64',
    exe_extension: '',
  },
});

function silenceConsole() {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
}
silenceConsole();

vi.stubGlobal(
  'matchMedia',
  vi.fn(() => ({
    matches: false,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })),
);
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
HTMLElement.prototype.scrollTo = vi.fn();
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
Range.prototype.getBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
document.elementFromPoint = () => null;
Object.assign(navigator, {
  clipboard: { readText: vi.fn(), writeText: vi.fn(() => Promise.resolve()) },
});
if (!URL.createObjectURL) {
  Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:mock-object-url') });
}
if (!URL.revokeObjectURL) {
  Object.assign(URL, { revokeObjectURL: vi.fn() });
}
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
  silenceConsole();
});
afterEach(cleanup);
