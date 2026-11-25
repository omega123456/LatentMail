import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isMacPlatform } from '@/lib/keyboard/format';
import { dispatchKey } from '@/lib/keyboard/dispatch';
import {
  anchoredScroll,
  clampZoom,
  fitZoom,
  stepZoom,
  wheelZoom,
  type FitMode,
  type Size,
  type ZoomMode,
  viewportCentre,
} from './zoom';

type Point = { x: number; y: number };
type ScrollPosition = { left: number; top: number };
type ZoomSnapshot = { zoom: number; content: Size | null; viewport: Size | null };
type GestureEventLike = Event & { scale: number; clientX: number; clientY: number };

export type ZoomPreset = FitMode | number;

function resolveZoomLevel({
  view,
  content,
  viewport,
  fitCap,
}: {
  view: { mode: ZoomMode; zoom: number };
  content: Size | null;
  viewport: Size | null;
  fitCap: number;
}): number {
  if (view.mode === 'custom') return view.zoom;
  if (!content || !viewport) return 1;
  return fitZoom({ mode: view.mode, content: content, viewport: viewport, cap: fitCap });
}

function computeAnchoredScroll({
  element,
  size,
  current,
  target,
  anchor,
  pending,
}: {
  element: HTMLElement;
  size: Size;
  current: number;
  target: number;
  anchor?: Point;
  pending: ScrollPosition | null;
}): ScrollPosition {
  const point = anchor ?? viewportCentre(element);
  const scroll = pending ?? { left: element.scrollLeft, top: element.scrollTop };
  return {
    left: anchoredScroll({
      scroll: scroll.left,
      anchor: point.x,
      viewport: element.clientWidth,
      base: size.width,
      from: current,
      to: target,
    }),
    top: anchoredScroll({
      scroll: scroll.top,
      anchor: point.y,
      viewport: element.clientHeight,
      base: size.height,
      from: current,
      to: target,
    }),
  };
}

function resolveFitPreset(preset: FitMode, snapshot: ZoomSnapshot, fitCap: number): number {
  if (!snapshot.content || !snapshot.viewport) return snapshot.zoom;
  return fitZoom({
    mode: preset,
    content: snapshot.content,
    viewport: snapshot.viewport,
    cap: fitCap,
  });
}

function useViewportObserver(scrollRef: RefObject<HTMLElement | null>): Size | null {
  const [viewport, setViewport] = useState<Size | null>(null);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef]);
  return viewport;
}

function usePendingScrollFlush(
  scrollRef: RefObject<HTMLElement | null>,
  pendingScrollRef: RefObject<ScrollPosition | null>,
  zoom: number,
) {
  useLayoutEffect(() => {
    const element = scrollRef.current;
    const pending = pendingScrollRef.current;
    if (!element || !pending) return;
    pendingScrollRef.current = null;
    element.scrollLeft = pending.left;
    element.scrollTop = pending.top;
  }, [zoom, scrollRef, pendingScrollRef]);
}

function useZoomPointerGestures({
  scrollRef,
  latestRef,
  applyZoom,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  latestRef: RefObject<ZoomSnapshot>;
  applyZoom: (mode: ZoomMode, target: number, anchor?: Point) => void;
}) {
  const gestureStartZoomRef = useRef(1);
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const anchorOf = (event: { clientX: number; clientY: number }) => {
      const rect = element.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      applyZoom('custom', wheelZoom(latestRef.current.zoom, event.deltaY), anchorOf(event));
    };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoomRef.current = latestRef.current.zoom;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEventLike;
      applyZoom(
        'custom',
        clampZoom(gestureStartZoomRef.current * gesture.scale),
        anchorOf(gesture),
      );
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart);
    element.addEventListener('gesturechange', onGestureChange);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
    };
  }, [applyZoom, scrollRef, latestRef]);
}

function useZoomKeyboardShortcuts({
  zoomIn,
  zoomOut,
  reset,
}: {
  zoomIn: () => void;
  zoomOut: () => void;
  reset: () => void;
}) {
  useEffect(() => {
    const isMac = isMacPlatform();
    const handlers = { '=': zoomIn, '+': zoomIn, '-': zoomOut, '0': reset };
    const onKeyDown = (event: KeyboardEvent) => {
      const hasPrimaryModifier = isMac ? event.metaKey : event.ctrlKey;
      if (!hasPrimaryModifier || event.altKey) return;
      dispatchKey(event, handlers);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [zoomIn, zoomOut, reset]);
}

function useApplyZoom({
  scrollRef,
  latestRef,
  pendingScrollRef,
  setView,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  latestRef: RefObject<ZoomSnapshot>;
  pendingScrollRef: RefObject<ScrollPosition | null>;
  setView: (view: { mode: ZoomMode; zoom: number }) => void;
}) {
  return useCallback(
    (mode: ZoomMode, target: number, anchor?: Point) => {
      const element = scrollRef.current;
      const { zoom: current, content: size } = latestRef.current;
      if (element && size && target !== current) {
        pendingScrollRef.current = computeAnchoredScroll({
          element: element,
          size: size,
          current: current,
          target: target,
          anchor: anchor,
          pending: pendingScrollRef.current,
        });
      }
      latestRef.current = { ...latestRef.current, zoom: target };
      setView({ mode: mode, zoom: target });
    },
    [scrollRef, latestRef, pendingScrollRef, setView],
  );
}

function useZoomPresetActions({
  applyZoom,
  latestRef,
  defaultMode,
  fitCap,
}: {
  applyZoom: (mode: ZoomMode, target: number, anchor?: Point) => void;
  latestRef: RefObject<ZoomSnapshot>;
  defaultMode: FitMode;
  fitCap: number;
}) {
  const selectPreset = useCallback(
    (preset: ZoomPreset) => {
      if (typeof preset === 'number') {
        applyZoom('custom', clampZoom(preset));
        return;
      }
      applyZoom(preset, resolveFitPreset(preset, latestRef.current, fitCap));
    },
    [applyZoom, fitCap, latestRef],
  );
  const zoomIn = useCallback(
    () => applyZoom('custom', stepZoom(latestRef.current.zoom, 1)),
    [applyZoom, latestRef],
  );
  const zoomOut = useCallback(
    () => applyZoom('custom', stepZoom(latestRef.current.zoom, -1)),
    [applyZoom, latestRef],
  );
  const reset = useCallback(() => selectPreset(defaultMode), [selectPreset, defaultMode]);
  return { selectPreset, zoomIn, zoomOut, reset };
}

export function useZoom({
  scrollRef,
  content,
  defaultMode,
  fitCap,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  content: Size | null;
  defaultMode: FitMode;
  fitCap: number;
}) {
  const [view, setView] = useState<{ mode: ZoomMode; zoom: number }>({
    mode: defaultMode,
    zoom: 1,
  });
  const viewport = useViewportObserver(scrollRef);
  const zoom = resolveZoomLevel({ view, content, viewport, fitCap });
  const latestRef = useRef<ZoomSnapshot>({ zoom: 1, content: null, viewport: null });
  const pendingScrollRef = useRef<ScrollPosition | null>(null);

  useLayoutEffect(() => {
    latestRef.current = { zoom, content, viewport };
  });

  usePendingScrollFlush(scrollRef, pendingScrollRef, zoom);
  const applyZoom = useApplyZoom({ scrollRef, latestRef, pendingScrollRef, setView });
  const { selectPreset, zoomIn, zoomOut, reset } = useZoomPresetActions({
    applyZoom,
    latestRef,
    defaultMode,
    fitCap,
  });

  useZoomPointerGestures({ scrollRef, latestRef, applyZoom });
  useZoomKeyboardShortcuts({ zoomIn, zoomOut, reset });

  return {
    zoom: zoom,
    mode: view.mode,
    viewport: viewport,
    ready: content !== null && viewport !== null,
    zoomIn: zoomIn,
    zoomOut: zoomOut,
    selectPreset: selectPreset,
  };
}
