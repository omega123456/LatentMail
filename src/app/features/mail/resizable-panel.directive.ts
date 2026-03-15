import { Directive, ElementRef, input, output, OnInit, OnDestroy, Renderer2, inject } from '@angular/core';

export type ResizeDirection = 'horizontal' | 'vertical';
export type ResizeSide = 'right' | 'left';

@Directive({
  selector: '[appResizablePanel]',
  standalone: true,
})
export class ResizablePanelDirective implements OnInit, OnDestroy {
  /* c8 ignore start -- drag interaction, accepted coverage gap */
  readonly direction = input<ResizeDirection>('horizontal');
  readonly side = input<ResizeSide>('right');
  readonly minSize = input(180);
  readonly maxSize = input(600);
  readonly resized = output<number>();

  private readonly el = inject(ElementRef);
  private readonly renderer = inject(Renderer2);
  private handle!: HTMLElement;
  private dragging = false;
  private startPos = 0;
  private startSize = 0;
  private cleanupFns: (() => void)[] = [];
  private rafId: number | null = null;
  private pendingSize: number | null = null;

  ngOnInit(): void {
    this.createHandle();
  }

  ngOnDestroy(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.cleanupFns.forEach(fn => fn());
  }

  private createHandle(): void {
    const el = this.el.nativeElement as HTMLElement;
    this.renderer.setStyle(el, 'position', 'relative');

    this.handle = this.renderer.createElement('div');

    if (this.direction() === 'horizontal') {
      this.renderer.setStyle(this.handle, 'position', 'absolute');
      this.renderer.setStyle(this.handle, 'top', '0');
      if (this.side() === 'left') {
        this.renderer.setStyle(this.handle, 'left', '-3px');
      } else {
        this.renderer.setStyle(this.handle, 'right', '-3px');
      }
      this.renderer.setStyle(this.handle, 'width', '6px');
      this.renderer.setStyle(this.handle, 'height', '100%');
      this.renderer.setStyle(this.handle, 'cursor', 'col-resize');
      this.renderer.setStyle(this.handle, 'z-index', '10');
    } else {
      this.renderer.setStyle(this.handle, 'position', 'absolute');
      this.renderer.setStyle(this.handle, 'bottom', '-3px');
      this.renderer.setStyle(this.handle, 'left', '0');
      this.renderer.setStyle(this.handle, 'height', '6px');
      this.renderer.setStyle(this.handle, 'width', '100%');
      this.renderer.setStyle(this.handle, 'cursor', 'row-resize');
      this.renderer.setStyle(this.handle, 'z-index', '10');
    }

    // Hover indicator
    this.renderer.setStyle(this.handle, 'transition', 'background-color 150ms ease');

    this.renderer.appendChild(el, this.handle);

    const mouseEnter = this.renderer.listen(this.handle, 'mouseenter', () => {
      if (!this.dragging) {
        this.renderer.setStyle(this.handle, 'background-color', 'var(--color-primary)');
        this.renderer.setStyle(this.handle, 'opacity', '0.3');
      }
    });
    this.cleanupFns.push(mouseEnter);

    const mouseLeave = this.renderer.listen(this.handle, 'mouseleave', () => {
      if (!this.dragging) {
        this.renderer.setStyle(this.handle, 'background-color', 'transparent');
        this.renderer.setStyle(this.handle, 'opacity', '1');
      }
    });
    this.cleanupFns.push(mouseLeave);

    const mouseDown = this.renderer.listen(this.handle, 'mousedown', (e: MouseEvent) => {
      e.preventDefault();
      this.dragging = true;
      this.startPos = this.direction() === 'horizontal' ? e.clientX : e.clientY;
      this.startSize = this.direction() === 'horizontal' ? el.offsetWidth : el.offsetHeight;
      this.pendingSize = null;
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      // Disable transition so width follows cursor immediately (no lag)
      this.renderer.setStyle(el, 'transition', 'none');
      this.renderer.setStyle(this.handle, 'background-color', 'var(--color-primary)');
      this.renderer.setStyle(this.handle, 'opacity', '0.5');
      this.renderer.setStyle(document.body, 'cursor', this.direction() === 'horizontal' ? 'col-resize' : 'row-resize');
      this.renderer.setStyle(document.body, 'user-select', 'none');
    });
    this.cleanupFns.push(mouseDown);

    const mouseMove = this.renderer.listen('document', 'mousemove', (e: MouseEvent) => {
      if (!this.dragging) { return; }
      const currentPos = this.direction() === 'horizontal' ? e.clientX : e.clientY;
      // For left-side handle: drag left → negative clientX delta → panel grows (negate delta).
      const rawDelta = currentPos - this.startPos;
      const delta = (this.direction() === 'horizontal' && this.side() === 'left') ? -rawDelta : rawDelta;
      const newSize = Math.max(this.minSize(), Math.min(this.maxSize(), this.startSize + delta));

      // Update size immediately so panel follows cursor (no transition during drag)
      if (this.direction() === 'horizontal') {
        this.renderer.setStyle(el, 'width', `${newSize}px`);
      } else {
        this.renderer.setStyle(el, 'height', `${newSize}px`);
      }
      // Throttle store/localStorage updates to once per frame
      this.pendingSize = newSize;
      if (this.rafId === null) {
        this.rafId = requestAnimationFrame(() => {
          this.rafId = null;
          if (this.pendingSize !== null) {
            this.resized.emit(this.pendingSize);
            this.pendingSize = null;
          }
        });
      }
    });
    this.cleanupFns.push(mouseMove);

    const mouseUp = this.renderer.listen('document', 'mouseup', () => {
      if (!this.dragging) { return; }
      this.dragging = false;
      if (this.rafId !== null) {
        cancelAnimationFrame(this.rafId);
        this.rafId = null;
      }
      // Emit final size so store/localStorage are in sync
      const currentSize = this.direction() === 'horizontal' ? el.offsetWidth : el.offsetHeight;
      const finalSize = Math.max(this.minSize(), Math.min(this.maxSize(), currentSize));
      this.resized.emit(finalSize);
      this.pendingSize = null;
      // Restore transition for open/close animations
      this.renderer.removeStyle(el, 'transition');
      this.renderer.setStyle(this.handle, 'background-color', 'transparent');
      this.renderer.setStyle(this.handle, 'opacity', '1');
      this.renderer.removeStyle(document.body, 'cursor');
      this.renderer.removeStyle(document.body, 'user-select');
    });
      this.cleanupFns.push(mouseUp);
  }
  /* c8 ignore stop */
}
