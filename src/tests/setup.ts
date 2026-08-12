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
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
HTMLElement.prototype.scrollIntoView = vi.fn();

beforeEach(() => ipc.reset());
// Unmount, don't just wipe the DOM: clearing `innerHTML` leaves the previous
// test's React tree mounted and still subscribed to the Zustand stores, so it
// keeps reacting to (and fighting over) state the next test sets up.
afterEach(cleanup);
