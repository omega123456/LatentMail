import {
  Component,
  input,
  viewChild,
  effect,
  ElementRef,
  AfterViewInit,
  OnDestroy,
  signal,
  computed,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import DOMPurify from 'dompurify';
import { SettingsStore } from '../../../store/settings.store';

/** 1×1 grey GIF placeholder URI used while remote images are blocked. */
const BLOCKED_IMAGE_PLACEHOLDER =
  'data:image/gif;base64,R0lGODlhAQABAIAAAMLCwgAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==';

/**
 * The iframe srcdoc shell includes a `<style>` that gives blocked images
 * (those with `data-src` in place of their real `src`) a grey box so they
 * don't collapse to 0×0 and confuse readers about missing content.
 */
const SRCDOC_SHELL_HEAD =
  '<!DOCTYPE html><html>' +
  '<head>' +
  '<meta charset="utf-8">' +
  '<base target="_blank">' +
  '<style>' +
  'img[data-src]{display:inline-block;min-width:24px;min-height:24px;' +
  'background:#e0e0e0;border:1px dashed #aaa;vertical-align:middle;}' +
  '</style>' +
  '</head>' +
  '<body style="margin:0;padding:0;font-size:14px;line-height:1.6;' +
  'font-family:inherit;color:inherit;word-break:break-word;">';

/** Injected into srcdoc to report content height to parent when body size changes (e.g. after images load). */
const SRCDOC_RESIZE_SCRIPT =
  '<script>(function(){function sendHeight(){var b=document.body,h=document.documentElement,hgt=Math.max(b.scrollHeight,b.offsetHeight,h.scrollHeight,h.offsetHeight,120);if(window.parent!==window)window.parent.postMessage({type:"email-body-frame-resize",height:hgt},"*")}sendHeight();if(typeof ResizeObserver!=="undefined"){var ro=new ResizeObserver(sendHeight);ro.observe(document.body)}window.addEventListener("load",sendHeight)})();<\/script>';
const SRCDOC_SHELL_TAIL = SRCDOC_RESIZE_SCRIPT + '</body></html>';

@Component({
  selector: 'app-email-body-frame',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './email-body-frame.component.html',
  styleUrls: ['./email-body-frame.component.scss'],
})
export class EmailBodyFrameComponent implements AfterViewInit, OnDestroy {
  readonly htmlBody = input<string>('');
  /** The sender's email address (used for the per-sender image allowlist). */
  readonly senderEmail = input<string>('');

  private readonly settingsStore = inject(SettingsStore);

  readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');

  /**
   * Whether remote images are currently blocked for this message.
   * Drives the "Load images" banner visibility.
   *
   * True when ALL of the following hold:
   *  - `blockRemoteImages` is on in settings
   *  - the user has not clicked "Load once" for this email
   *  - the sender is not in the per-sender allowlist
   *  - the HTML body contains at least one remote `<img>` with an http(s) src
   */
  readonly imagesBlocked = computed(() => {
    const blockImages = this.settingsStore.blockRemoteImages();
    const bypass = this.bypassBlock();
    const sender = (this.senderEmail() ?? '').toLowerCase();
    const allowedSenders = this.settingsStore.allowedImageSenders();

    if (!blockImages || bypass) {
      return false;
    }
    if (sender && allowedSenders.some((s) => s.toLowerCase() === sender)) {
      return false;
    }
    // Quick regex check: does the body contain a remote <img> src?
    // Matches http://, https://, and protocol-relative // URLs.
    return /<img\b[^>]+\bsrc\s*=\s*["'](?:https?:)?\/\//i.test(this.htmlBody());
  });

  /**
   * Per-email "Load once" flag — set to true when the user clicks the
   * "Load images" button.  Automatically resets when the email changes.
   */
  readonly bypassBlock = signal(false);

  /** Last htmlBody value we saw; used to reset bypass only when the body actually changes. */
  private lastBodyForBypassReset: string | undefined = undefined;

  constructor() {
    // Reset the per-email bypass only when the email body actually changes (e.g. user switched message).
    effect(() => {
      const currentBody = this.htmlBody();
      if (
        this.lastBodyForBypassReset !== undefined &&
        this.lastBodyForBypassReset !== currentBody
      ) {
        this.bypassBlock.set(false);
      }
      this.lastBodyForBypassReset = currentBody;
    });

    // Re-render the iframe whenever the body, sender, settings, or bypass change.
    effect(() => {
      const body = this.htmlBody();
      const blockImages = this.settingsStore.blockRemoteImages();
      const allowedSenders = this.settingsStore.allowedImageSenders();
      const bypass = this.bypassBlock();
      const sender = this.senderEmail();
      const iframeElement = this.frame()?.nativeElement;
      if (iframeElement) {
        this.writeSrcdoc(iframeElement, body, blockImages, allowedSenders, sender, bypass);
      }
    });
  }

  private readonly boundMessageHandler = (event: MessageEvent): void => this.onMessage(event);

  ngAfterViewInit(): void {
    const iframeElement = this.frame()?.nativeElement;
    if (iframeElement) {
      this.writeSrcdoc(
        iframeElement,
        this.htmlBody(),
        this.settingsStore.blockRemoteImages(),
        this.settingsStore.allowedImageSenders(),
        this.senderEmail(),
        this.bypassBlock(),
      );
    }
    window.addEventListener('message', this.boundMessageHandler);
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.boundMessageHandler);
  }

  private onMessage(event: MessageEvent): void {
    const iframeElement = this.frame()?.nativeElement;
    if (
      !iframeElement ||
      event.source !== iframeElement.contentWindow ||
      event.data?.type !== 'email-body-frame-resize' ||
      typeof event.data.height !== 'number'
    ) {
      return;
    }
    const height = Math.max(120, Math.min(event.data.height, 50_000));
    iframeElement.style.height = `${height}px`;
  }

  onIframeLoad(): void {
    this.resizeFrameToContent();
  }

  /** Load images for this message only — does not persist to settings. */
  loadImagesOnce(): void {
    this.bypassBlock.set(true);
    const iframeElement = this.frame()?.nativeElement;
    if (iframeElement) {
      this.writeSrcdoc(
        iframeElement,
        this.htmlBody(),
        this.settingsStore.blockRemoteImages(),
        this.settingsStore.allowedImageSenders(),
        this.senderEmail(),
        true,
      );
    }
  }

  /** Always load images from this sender — persists the address to settings. */
  async alwaysAllowSender(): Promise<void> {
    const email = this.senderEmail();
    if (email) {
      await this.settingsStore.addAllowedImageSender(email);
      const iframeElement = this.frame()?.nativeElement;
      if (iframeElement) {
        this.writeSrcdoc(
          iframeElement,
          this.htmlBody(),
          this.settingsStore.blockRemoteImages(),
          this.settingsStore.allowedImageSenders(),
          this.senderEmail(),
          this.bypassBlock(),
        );
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private buildSrcdoc(
    rawBody: string,
    blockImages: boolean,
    allowedSenders: string[],
    senderEmailValue: string,
    bypass: boolean,
  ): string {
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

    // Remove any remaining script tags and content (defense in depth)
    const noScript = sanitized.replace(/<script\b[\s\S]*?<\/script>/gi, '');

    // Apply remote-image blocking if the setting is active and the sender is not allowed.
    const senderLower = (senderEmailValue ?? '').toLowerCase();
    const senderAllowed = senderLower
      ? allowedSenders.some((s) => s.toLowerCase() === senderLower)
      : false;

    if (blockImages && !bypass && !senderAllowed) {
      const blocked = this.blockRemoteImagesInHtml(noScript);
      return SRCDOC_SHELL_HEAD + blocked + SRCDOC_SHELL_TAIL;
    }

    return SRCDOC_SHELL_HEAD + noScript + SRCDOC_SHELL_TAIL;
  }

  /**
   * Parse `html` as a DOM fragment, replace remote `<img>` src values with a grey
   * placeholder, and store the original URL in `data-src`.
   *
   * Blocks: http://, https://, and protocol-relative // URLs.
   * Note: srcset / CSS background images are not rewritten (out of spec scope).
   */
  private blockRemoteImagesInHtml(html: string): string {
    const container = document.createElement('div');
    container.innerHTML = html;

    const images = Array.from(container.querySelectorAll('img'));
    for (const img of images) {
      const src = (img.getAttribute('src') ?? '').trim();
      if (
        src.startsWith('http://') ||
        src.startsWith('https://') ||
        src.startsWith('//')
      ) {
        img.setAttribute('data-src', src);
        img.setAttribute('src', BLOCKED_IMAGE_PLACEHOLDER);
      }
    }

    return container.innerHTML;
  }

  private writeSrcdoc(
    iframe: HTMLIFrameElement,
    rawBody: string,
    blockImages: boolean,
    allowedSenders: string[],
    senderEmailValue: string,
    bypass: boolean,
  ): void {
    iframe.srcdoc = this.buildSrcdoc(rawBody, blockImages, allowedSenders, senderEmailValue, bypass);
  }

  private resizeFrameToContent(): void {
    const iframeElement = this.frame()?.nativeElement;
    if (!iframeElement?.contentDocument?.body) {
      return;
    }
    try {
      const doc = iframeElement.contentDocument;
      const body = doc.body;
      const html = doc.documentElement;
      const height = Math.max(
        body.scrollHeight,
        body.offsetHeight,
        html.scrollHeight,
        html.offsetHeight,
        120,
      );
      iframeElement.style.height = `${height}px`;
    } catch {
      // Cross-origin or security restriction; leave height as-is
    }
  }
}
