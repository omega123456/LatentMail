import {
  Component,
  input,
  viewChild,
  effect,
  ElementRef,
  AfterViewInit,
} from '@angular/core';
import DOMPurify from 'dompurify';

const SRCDOC_SHELL_HEAD =
  '<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"></head><body style="margin:0;padding:0;font-size:14px;line-height:1.6;font-family:inherit;color:inherit;word-break:break-word;">';
const SRCDOC_SHELL_TAIL = '</body></html>';

@Component({
  selector: 'app-email-body-frame',
  standalone: true,
  templateUrl: './email-body-frame.component.html',
  styleUrls: ['./email-body-frame.component.scss'],
})
export class EmailBodyFrameComponent implements AfterViewInit {
  readonly htmlBody = input<string>('', { alias: 'htmlBody' });

  readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  constructor() {
    effect(() => {
      const body = this.htmlBody();
      const el = this.frame()?.nativeElement;
      if (el) {
        this.writeSrcdoc(el, body ?? '');
      }
    });
  }

  ngAfterViewInit(): void {
    const body = this.htmlBody();
    const el = this.frame()?.nativeElement;
    if (el) {
      this.writeSrcdoc(el, body ?? '');
    }
  }

  onIframeLoad(): void {
    this.resizeFrameToContent();
  }

  private buildSrcdoc(rawBody: string | undefined): string {
    const body = rawBody ?? '';
    if (!body.trim()) {
      return SRCDOC_SHELL_HEAD + SRCDOC_SHELL_TAIL;
    }
    const sanitized = DOMPurify.sanitize(body, {
      ADD_ATTR: ['target'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form'],
      FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
    }) ?? '';
    return SRCDOC_SHELL_HEAD + sanitized + SRCDOC_SHELL_TAIL;
  }

  private writeSrcdoc(iframe: HTMLIFrameElement, rawBody: string | undefined): void {
    iframe.srcdoc = this.buildSrcdoc(rawBody);
  }

  private resizeFrameToContent(): void {
    const el = this.frame()?.nativeElement;
    if (!el?.contentDocument?.body) return;
    try {
      const doc = el.contentDocument;
      const body = doc.body;
      const html = doc.documentElement;
      const height = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.scrollHeight,
        html.offsetHeight,
        120
      );
      el.style.height = `${height}px`;
    } catch {
      // Cross-origin or security; leave height as-is
    }
  }
}
