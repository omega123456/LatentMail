export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];
export const PREVIEW_PADDING = 16;

const STEP_TOLERANCE = 1e-6;
const FIT_PRECISION = 1000;
const WHEEL_DELTA_LIMIT = 60;
const WHEEL_DELTA_PER_E_FOLD = 220;

export type FitMode = 'fit-width' | 'fit-page';
export type ZoomMode = FitMode | 'custom';
export type Size = { width: number; height: number };

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

export function stepZoom(zoom: number, direction: 1 | -1): number {
  const next =
    direction > 0
      ? ZOOM_STEPS.find((step) => step > zoom + STEP_TOLERANCE)
      : [...ZOOM_STEPS].reverse().find((step) => step < zoom - STEP_TOLERANCE);
  return next ?? zoom;
}

export function fitZoom(mode: FitMode, content: Size, viewport: Size, cap: number): number {
  const byWidth = viewport.width / content.width;
  const fit = mode === 'fit-width' ? byWidth : Math.min(byWidth, viewport.height / content.height);
  return clampZoom(Math.floor(Math.min(cap, fit) * FIT_PRECISION) / FIT_PRECISION);
}

export function wheelZoom(zoom: number, deltaY: number): number {
  const delta = Math.max(-WHEEL_DELTA_LIMIT, Math.min(WHEEL_DELTA_LIMIT, deltaY));
  return clampZoom(zoom * Math.exp(-delta / WHEEL_DELTA_PER_E_FOLD));
}

export function anchoredScroll({
  scroll,
  anchor,
  viewport,
  base,
  from,
  to,
}: {
  scroll: number;
  anchor: number;
  viewport: number;
  base: number;
  from: number;
  to: number;
}): number {
  const centringOffset = (zoom: number) => Math.max(0, (viewport - base * zoom) / 2);
  const point = (scroll + anchor - centringOffset(from)) / from;
  return Math.max(0, point * to + centringOffset(to) - anchor);
}

export function formatZoom(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}
