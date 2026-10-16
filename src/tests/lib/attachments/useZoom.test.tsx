import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { useZoom } from '@/lib/attachments/useZoom';
import type { FitMode, Size } from '@/lib/attachments/zoom';

function setPlatform(platform: string) {
  Object.defineProperty(window.navigator, 'platform', { value: platform, configurable: true });
}

function scrollElement(width = 400, height = 300) {
  const element = document.createElement('div');
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: height, configurable: true });
  document.body.appendChild(element);
  return element;
}

function measure() {
  act(() =>
    (window.__resizeObserverInstances__ ?? []).forEach((instance) =>
      instance.callback([], {} as ResizeObserver),
    ),
  );
}

function setup({
  content = { width: 200, height: 400 },
  defaultMode = 'fit-width',
  fitCap = 1.25,
  element = scrollElement(),
}: {
  content?: Size | null;
  defaultMode?: FitMode;
  fitCap?: number;
  element?: HTMLDivElement | null;
} = {}) {
  const scrollRef = { current: element };
  const hook = renderHook(() => useZoom({ scrollRef, content, defaultMode, fitCap }));
  return { ...hook, element };
}

afterEach(() => {
  setPlatform('');
  document.body.innerHTML = '';
});

describe('useZoom', () => {
  it('waits for a measurement, then fits the width up to the cap', () => {
    const { result } = setup();
    expect(result.current.ready).toBe(false);
    expect(result.current.zoom).toBe(1);
    measure();
    expect(result.current.ready).toBe(true);
    expect(result.current.mode).toBe('fit-width');
    expect(result.current.zoom).toBe(1.25);
    expect(result.current.viewport).toEqual({ width: 400, height: 300 });
  });

  it('fits the whole page when that is the default', () => {
    const { result } = setup({ defaultMode: 'fit-page', fitCap: 4 });
    measure();
    expect(result.current.zoom).toBe(0.75);
  });

  it('steps the ladder from the buttons and keeps the centre of the view in place', () => {
    const { result, element } = setup();
    measure();
    act(() => result.current.zoomIn());
    expect(result.current.mode).toBe('custom');
    expect(result.current.zoom).toBe(1.5);
    expect(element?.scrollLeft).toBe(0);
    expect(element?.scrollTop).toBe(30);
    act(() => result.current.zoomOut());
    expect(result.current.zoom).toBe(1.25);
  });

  it('chains zoom changes made before a render from the pending scroll position', () => {
    const { result } = setup();
    measure();
    act(() => {
      result.current.zoomIn();
      result.current.zoomIn();
    });
    expect(result.current.zoom).toBe(2);
  });

  it('selects a fixed preset or a fit mode from the menu', () => {
    const { result } = setup({ fitCap: 4 });
    measure();
    act(() => result.current.selectPreset(9));
    expect(result.current.zoom).toBe(4);
    act(() => result.current.selectPreset('fit-page'));
    expect(result.current.mode).toBe('fit-page');
    expect(result.current.zoom).toBe(0.75);
  });

  it('keeps the current zoom when a fit mode is chosen before anything is measured', () => {
    const { result } = setup({ content: null });
    act(() => result.current.selectPreset('fit-page'));
    expect(result.current.zoom).toBe(1);
    act(() => result.current.zoomIn());
    expect(result.current.zoom).toBe(1.25);
  });

  it('uses Command on macOS for zoom in, out and reset', () => {
    setPlatform('MacIntel');
    const { result } = setup();
    measure();
    fireEvent.keyDown(document, { key: '=', metaKey: true });
    expect(result.current.zoom).toBe(1.5);
    fireEvent.keyDown(document, { key: '+', metaKey: true });
    expect(result.current.zoom).toBe(2);
    fireEvent.keyDown(document, { key: '-', metaKey: true });
    expect(result.current.zoom).toBe(1.5);
    fireEvent.keyDown(document, { key: '=', ctrlKey: true });
    expect(result.current.zoom).toBe(1.5);
    fireEvent.keyDown(document, { key: '0', metaKey: true });
    expect(result.current.mode).toBe('fit-width');
    expect(result.current.zoom).toBe(1.25);
  });

  it('uses Ctrl on Windows and ignores other chords', () => {
    setPlatform('Win32');
    const { result } = setup();
    measure();
    expect(fireEvent.keyDown(document, { key: '-', ctrlKey: true })).toBe(false);
    expect(result.current.zoom).toBe(1);
    expect(fireEvent.keyDown(document, { key: '=', ctrlKey: true, altKey: true })).toBe(true);
    expect(fireEvent.keyDown(document, { key: 'p', ctrlKey: true })).toBe(true);
    expect(fireEvent.keyDown(document, { key: '=', metaKey: true })).toBe(true);
    expect(result.current.zoom).toBe(1);
  });

  it('zooms with a modified wheel at the pointer and leaves plain scrolling alone', () => {
    const { result, element } = setup();
    measure();
    const plain = new WheelEvent('wheel', { deltaY: -60, cancelable: true });
    act(() => {
      element?.dispatchEvent(plain);
    });
    expect(plain.defaultPrevented).toBe(false);
    expect(result.current.zoom).toBe(1.25);

    const pinch = new WheelEvent('wheel', {
      deltaY: -60,
      ctrlKey: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    act(() => {
      element?.dispatchEvent(pinch);
    });
    expect(pinch.defaultPrevented).toBe(true);
    expect(result.current.mode).toBe('custom');
    expect(result.current.zoom).toBeGreaterThan(1.25);
  });

  it('follows a WebKit pinch gesture relative to the zoom it started from', () => {
    const { result, element } = setup();
    measure();
    const start = new Event('gesturestart', { cancelable: true });
    const change = Object.assign(new Event('gesturechange', { cancelable: true }), {
      scale: 2,
      clientX: 0,
      clientY: 0,
    });
    act(() => {
      element?.dispatchEvent(start);
      element?.dispatchEvent(change);
    });
    expect(start.defaultPrevented).toBe(true);
    expect(change.defaultPrevented).toBe(true);
    expect(result.current.zoom).toBe(2.5);
  });

  it('does nothing to the DOM when there is no scroll element', () => {
    const { result } = setup({ element: null });
    act(() => result.current.zoomIn());
    expect(result.current.zoom).toBe(1.25);
    expect(result.current.ready).toBe(false);
  });
});
