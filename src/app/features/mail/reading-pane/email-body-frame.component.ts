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
      FORBID_ATTR: [
        'onerror', 'onload', 'onclick', 'onmouseover', 'onmouseout', 'onmouseenter', 'onmouseleave',
        'onmousedown', 'onmouseup', 'ondblclick', 'onkeydown', 'onkeyup', 'onkeypress',
        'onsubmit', 'onreset', 'onfocus', 'onblur', 'onchange', 'oninput', 'onselect',
        'onabort', 'oncanplay', 'oncanplaythrough', 'ondurationchange', 'onemptied', 'onended',
        'onloadeddata', 'onloadedmetadata', 'onloadstart', 'onpause', 'onplay', 'onplaying',
        'onprogress', 'onratechange', 'onreadystatechange', 'onseeked', 'onseeking',
        'onstalled', 'onsuspend', 'ontimeupdate', 'onvolumechange', 'onwaiting',
      ],
      // Allow data:image/* URIs so that inline images (CID-replaced) render correctly.
      // All other data: URIs (e.g. data:text/html) remain blocked.
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel|sms|callto|cid):|data:image\/[a-z+]+;base64,|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    }) ?? '';
    // Remove any remaining script tags and content (defense in depth; avoids "Blocked script execution" console noise)
    const noScript = sanitized.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    return SRCDOC_SHELL_HEAD + noScript + SRCDOC_SHELL_TAIL;
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
