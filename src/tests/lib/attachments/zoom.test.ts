import { describe, expect, it } from 'vitest';
import {
  anchoredScroll,
  centringOffset,
  clampZoom,
  fitZoom,
  formatZoom,
  MAX_ZOOM,
  MIN_ZOOM,
  paddedLength,
  PREVIEW_PADDING,
  stepZoom,
  viewportCentre,
  wheelZoom,
} from '@/lib/attachments/zoom';

const BELOW_MIN_ZOOM = 0.1;
const ABOVE_MAX_ZOOM = 9;
const IN_RANGE_ZOOM = 1.3;
const ACTUAL_SIZE = 1;
const STEP_BELOW_ACTUAL_SIZE = 0.75;
const STEP_ABOVE_ACTUAL_SIZE = 1.25;
const BETWEEN_STEPS = 1.18;
const ONE_AND_A_HALF = 1.5;
const GENEROUS_FIT_CAP = 4;
const FIT_CAP = 1.25;
const UNEVEN_VIEWPORT_WIDTH = 333.7;
const FLOORED_FIT_ZOOM = 1.668;
const FIT_ZOOM_DECIMALS = 6;
const SMALL_WHEEL_DELTA = 10;
const WHEEL_DELTA_LIMIT = 60;
const HUGE_WHEEL_DELTA = 1000;
const DOUBLE_ZOOM = 2;
const QUADRUPLE_ZOOM = 4;
const UNROUNDED_ZOOM = 1.177;

describe('zoom', () => {
  it('clamps to the 50–400% range', () => {
    expect(clampZoom(BELOW_MIN_ZOOM)).toBe(MIN_ZOOM);
    expect(clampZoom(ABOVE_MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(clampZoom(IN_RANGE_ZOOM)).toBe(IN_RANGE_ZOOM);
  });

  it('steps along the ladder and snaps from in-between values', () => {
    expect(stepZoom(ACTUAL_SIZE, 1)).toBe(STEP_ABOVE_ACTUAL_SIZE);
    expect(stepZoom(ACTUAL_SIZE, -1)).toBe(STEP_BELOW_ACTUAL_SIZE);
    expect(stepZoom(BETWEEN_STEPS, 1)).toBe(STEP_ABOVE_ACTUAL_SIZE);
    expect(stepZoom(BETWEEN_STEPS, -1)).toBe(ACTUAL_SIZE);
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
  });

  it('fits width or the whole page, capped and floored so the content never overflows', () => {
    const content = { width: 200, height: 400 };
    const squareViewport = { width: 300, height: 300 };
    const wideViewport = { width: 1000, height: 300 };
    const unevenViewport = { width: UNEVEN_VIEWPORT_WIDTH, height: 300 };
    const emptyViewport = { width: 0, height: 0 };
    expect(
      fitZoom({
        mode: 'fit-width',
        content: content,
        viewport: squareViewport,
        cap: GENEROUS_FIT_CAP,
      }),
    ).toBe(ONE_AND_A_HALF);
    expect(
      fitZoom({
        mode: 'fit-page',
        content: content,
        viewport: squareViewport,
        cap: GENEROUS_FIT_CAP,
      }),
    ).toBe(STEP_BELOW_ACTUAL_SIZE);
    expect(
      fitZoom({ mode: 'fit-width', content: content, viewport: wideViewport, cap: FIT_CAP }),
    ).toBe(FIT_CAP);
    const floored = fitZoom({
      mode: 'fit-width',
      content: content,
      viewport: unevenViewport,
      cap: GENEROUS_FIT_CAP,
    });
    expect(floored).toBeCloseTo(FLOORED_FIT_ZOOM, FIT_ZOOM_DECIMALS);
    expect(floored * content.width).toBeLessThanOrEqual(UNEVEN_VIEWPORT_WIDTH);
    expect(
      fitZoom({
        mode: 'fit-width',
        content: content,
        viewport: emptyViewport,
        cap: GENEROUS_FIT_CAP,
      }),
    ).toBe(MIN_ZOOM);
  });

  it('zooms smoothly with the wheel and limits a single large delta', () => {
    expect(wheelZoom(ACTUAL_SIZE, -SMALL_WHEEL_DELTA)).toBeGreaterThan(ACTUAL_SIZE);
    expect(wheelZoom(ACTUAL_SIZE, SMALL_WHEEL_DELTA)).toBeLessThan(ACTUAL_SIZE);
    expect(wheelZoom(ACTUAL_SIZE, HUGE_WHEEL_DELTA)).toBe(
      wheelZoom(ACTUAL_SIZE, WHEEL_DELTA_LIMIT),
    );
    expect(wheelZoom(MAX_ZOOM, -WHEEL_DELTA_LIMIT)).toBe(MAX_ZOOM);
  });

  it('keeps the anchored point under the pointer when content is larger than the viewport', () => {
    const doublingLargeContent = {
      scroll: 100,
      anchor: 50,
      viewport: 200,
      base: 1000,
      from: ACTUAL_SIZE,
      to: DOUBLE_ZOOM,
    };
    const expectedScroll = 250;
    expect(anchoredScroll(doublingLargeContent)).toBe(expectedScroll);
  });

  it('accounts for centring when content is smaller than the viewport and never scrolls negative', () => {
    const smallContent = { scroll: 0, anchor: 100, viewport: 200, base: 100 };
    const expectedScrollAfterZoomIn = 100;
    expect(anchoredScroll({ ...smallContent, from: ACTUAL_SIZE, to: QUADRUPLE_ZOOM })).toBe(
      expectedScrollAfterZoomIn,
    );
    expect(anchoredScroll({ ...smallContent, from: DOUBLE_ZOOM, to: ACTUAL_SIZE })).toBe(0);
  });

  it('formats as a whole percentage', () => {
    expect(formatZoom(STEP_ABOVE_ACTUAL_SIZE)).toBe('125%');
    expect(formatZoom(UNROUNDED_ZOOM)).toBe('118%');
  });

  it('centres content inside a larger viewport and pads both edges', () => {
    const viewport = 300;
    const content = 100;
    const expectedOffset = 100;
    expect(centringOffset(viewport, content)).toBe(expectedOffset);
    expect(centringOffset(content, viewport)).toBe(0);
    expect(paddedLength(content)).toBe(content + PREVIEW_PADDING + PREVIEW_PADDING);
  });

  it('finds the centre of an element viewport', () => {
    const element = document.createElement('div');
    Object.defineProperty(element, 'clientWidth', { value: 400 });
    Object.defineProperty(element, 'clientHeight', { value: 300 });
    expect(viewportCentre(element)).toEqual({ x: 200, y: 150 });
  });
});
