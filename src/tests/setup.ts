import '@testing-library/jest-dom/vitest';
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
afterEach(() => {
  document.body.innerHTML = '';
});
