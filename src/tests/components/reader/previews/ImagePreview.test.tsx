import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ImagePreview } from '@/components/reader/previews/ImagePreview';

function measure() {
  act(() =>
    (window.__resizeObserverInstances__ ?? []).forEach((instance) =>
      instance.callback([], {} as ResizeObserver),
    ),
  );
}

function loadImage(width: number, height: number) {
  const image = screen.getByRole('img', { name: 'scan.jpg' });
  Object.defineProperty(image, 'naturalWidth', { configurable: true, value: width });
  Object.defineProperty(image, 'naturalHeight', { configurable: true, value: height });
  fireEvent.load(image);
  return image;
}

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => 400,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 300,
  });
});

afterEach(() => {
  Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
  Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
});

describe('ImagePreview', () => {
  it('holds the zoom controls back until the image size is known', () => {
    render(<ImagePreview src="blob:scan" filename="scan.jpg" />);
    expect(screen.getByRole('img', { name: 'scan.jpg' })).toHaveAttribute('src', 'blob:scan');
    expect(screen.queryByRole('button', { name: 'Zoom in' })).not.toBeInTheDocument();
  });

  it('fits a large image into the view on open', () => {
    render(<ImagePreview src="blob:scan" filename="scan.jpg" />);
    const image = loadImage(640, 480);
    measure();
    expect(screen.getByRole('button', { name: 'Zoom level 59%' })).toBeInTheDocument();
    expect(image.parentElement).toHaveStyle({ width: `${672 * 0.585}px` });
  });

  it('never enlarges a small image past its own size on open, but zooms in on request', async () => {
    const user = userEvent.setup();
    render(<ImagePreview src="blob:scan" filename="scan.jpg" />);
    loadImage(100, 50);
    measure();
    expect(screen.getByRole('button', { name: 'Zoom level 100%' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Zoom in' }));
    expect(screen.getByRole('button', { name: 'Zoom level 125%' })).toBeInTheDocument();
  });
});
