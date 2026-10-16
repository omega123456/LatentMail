import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { isMacPlatform } from '@/lib/keyboard/format';
import {
  anchoredScroll,
  clampZoom,
  fitZoom,
  stepZoom,
  wheelZoom,
  type FitMode,
  type Size,
  type ZoomMode,
} from './zoom';

type Point = { x: number; y: number };
type GestureEventLike = Event & { scale: number; clientX: number; clientY: number };

export type ZoomPreset = FitMode | number;

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
  const [viewport, setViewport] = useState<Size | null>(null);
  const zoom =
    view.mode === 'custom'
      ? view.zoom
      : content && viewport
        ? fitZoom(view.mode, content, viewport, fitCap)
        : 1;
  const latest = useRef<{ zoom: number; content: Size | null; viewport: Size | null }>({
    zoom: 1,
    content: null,
    viewport: null,
  });
  const pendingScroll = useRef<{ left: number; top: number } | null>(null);
  const gestureStartZoom = useRef(1);

  useLayoutEffect(() => {
    latest.current = { zoom, content, viewport };
  });

  useLayoutEffect(() => {
    const element = scrollRef.current;
    const pending = pendingScroll.current;
    if (!element || !pending) return;
    pendingScroll.current = null;
    element.scrollLeft = pending.left;
    element.scrollTop = pending.top;
  }, [zoom, scrollRef]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() =>
      setViewport({ width: element.clientWidth, height: element.clientHeight }),
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [scrollRef]);

  const applyZoom = useCallback(
    (mode: ZoomMode, target: number, anchor?: Point) => {
      const element = scrollRef.current;
      const { zoom: current, content: size } = latest.current;
      if (element && size && target !== current) {
        const point = anchor ?? { x: element.clientWidth / 2, y: element.clientHeight / 2 };
        const scroll = pendingScroll.current ?? {
          left: element.scrollLeft,
          top: element.scrollTop,
        };
        pendingScroll.current = {
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
      latest.current = { ...latest.current, zoom: target };
      setView({ mode, zoom: target });
    },
    [scrollRef],
  );

  const selectPreset = useCallback(
    (preset: ZoomPreset) => {
      if (typeof preset === 'number') {
        applyZoom('custom', clampZoom(preset));
        return;
      }
      const { content: size, viewport: area, zoom: current } = latest.current;
      applyZoom(preset, size && area ? fitZoom(preset, size, area, fitCap) : current);
    },
    [applyZoom, fitCap],
  );

  const zoomIn = useCallback(
    () => applyZoom('custom', stepZoom(latest.current.zoom, 1)),
    [applyZoom],
  );
  const zoomOut = useCallback(
    () => applyZoom('custom', stepZoom(latest.current.zoom, -1)),
    [applyZoom],
  );
  const reset = useCallback(() => selectPreset(defaultMode), [selectPreset, defaultMode]);

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
      applyZoom('custom', wheelZoom(latest.current.zoom, event.deltaY), anchorOf(event));
    };
    const onGestureStart = (event: Event) => {
      event.preventDefault();
      gestureStartZoom.current = latest.current.zoom;
    };
    const onGestureChange = (event: Event) => {
      event.preventDefault();
      const gesture = event as GestureEventLike;
      applyZoom('custom', clampZoom(gestureStartZoom.current * gesture.scale), anchorOf(gesture));
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    element.addEventListener('gesturestart', onGestureStart);
    element.addEventListener('gesturechange', onGestureChange);
    return () => {
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('gesturestart', onGestureStart);
      element.removeEventListener('gesturechange', onGestureChange);
    };
  }, [applyZoom, scrollRef]);

  useEffect(() => {
    const isMac = isMacPlatform();
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(isMac ? event.metaKey : event.ctrlKey) || event.altKey) return;
      const action =
        event.key === '=' || event.key === '+'
          ? zoomIn
          : event.key === '-'
            ? zoomOut
            : event.key === '0'
              ? reset
              : null;
      if (!action) return;
      event.preventDefault();
      action();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [zoomIn, zoomOut, reset]);

  return {
    zoom,
    mode: view.mode,
    viewport,
    ready: content !== null && viewport !== null,
    zoomIn,
    zoomOut,
    selectPreset,
  };
}
