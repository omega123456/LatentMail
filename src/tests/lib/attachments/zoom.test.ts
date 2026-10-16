import { describe, expect, it } from 'vitest';
import {
  anchoredScroll,
  clampZoom,
  fitZoom,
  formatZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  stepZoom,
  wheelZoom,
} from '@/lib/attachments/zoom';

describe('zoom', () => {
  it('clamps to the 50–400% range', () => {
    expect(clampZoom(0.1)).toBe(MIN_ZOOM);
    expect(clampZoom(9)).toBe(MAX_ZOOM);
    expect(clampZoom(1.3)).toBe(1.3);
  });

  it('steps along the ladder and snaps from in-between values', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(1.18, 1)).toBe(1.25);
    expect(stepZoom(1.18, -1)).toBe(1);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it('fits width or the whole page, capped and floored so the content never overflows', () => {
    const content = { width: 200, height: 400 };
    expect(fitZoom('fit-width', content, { width: 300, height: 300 }, 4)).toBe(1.5);
    expect(fitZoom('fit-page', content, { width: 300, height: 300 }, 4)).toBe(0.75);
    expect(fitZoom('fit-width', content, { width: 1000, height: 300 }, 1.25)).toBe(1.25);
    const floored = fitZoom('fit-width', content, { width: 333.7, height: 300 }, 4);
    expect(floored).toBeCloseTo(1.668, 6);
    expect(floored * content.width).toBeLessThanOrEqual(333.7);
    expect(fitZoom('fit-width', content, { width: 0, height: 0 }, 4)).toBe(MIN_ZOOM);
  });

  it('zooms smoothly with the wheel and limits a single large delta', () => {
    expect(wheelZoom(1, -10)).toBeGreaterThan(1);
    expect(wheelZoom(1, 10)).toBeLessThan(1);
    expect(wheelZoom(1, 1000)).toBe(wheelZoom(1, 60));
    expect(wheelZoom(MAX_ZOOM, -60)).toBe(MAX_ZOOM);
  });

  it('keeps the anchored point under the pointer when content is larger than the viewport', () => {
    expect(
      anchoredScroll({ scroll: 100, anchor: 50, viewport: 200, base: 1000, from: 1, to: 2 }),
    ).toBe(250);
  });

  it('accounts for centring when content is smaller than the viewport and never scrolls negative', () => {
    expect(
      anchoredScroll({ scroll: 0, anchor: 100, viewport: 200, base: 100, from: 1, to: 4 }),
    ).toBe(100);
    expect(
      anchoredScroll({ scroll: 0, anchor: 100, viewport: 200, base: 100, from: 2, to: 1 }),
    ).toBe(0);
  });

  it('formats as a whole percentage', () => {
    expect(formatZoom(1.25)).toBe('125%');
    expect(formatZoom(1.177)).toBe('118%');
  });
});
