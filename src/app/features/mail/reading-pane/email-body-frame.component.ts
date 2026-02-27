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
  HostListener,
  untracked,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import DOMPurify from 'dompurify';
import { SettingsStore } from '../../../store/settings.store';
import { ZoomService } from '../../../core/services/zoom.service';

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
  '<script>(function(){function sendHeight(){var b=document.body,h=document.documentElement,hgt=Math.max(b.scrollHeight,b.offsetHeight,h.scrollHeight,h.offsetHeight,120);if(window.parent!==window)window.parent.postMessage({type:"email-body-frame-resize",height:hgt},"*")}function afterLayout(){requestAnimationFrame(function(){requestAnimationFrame(sendHeight)})}afterLayout();setTimeout(sendHeight,150);if(typeof ResizeObserver!=="undefined"){var ro=new ResizeObserver(sendHeight);ro.observe(document.body)}window.addEventListener("load",sendHeight)})();<\/script>';
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
  /** When true, viewing in Spam folder: always block remote images and use full DOMPurify for body. */
  readonly isSpamFolder = input<boolean>(false);

  private readonly settingsStore = inject(SettingsStore);
  private readonly zoomService = inject(ZoomService);

  readonly frame = viewChild<ElementRef<HTMLIFrameElement>>('frame');
  readonly wrapper = viewChild<ElementRef<HTMLDivElement>>('wrapper');

  /**
   * Most recently computed height cap in CSS pixels.
   * Updated by `applyMaxHeight()` whenever the wrapper's scroll container is measured.
   */
  private maxIframeHeight = 120;

  /**
   * Whether remote images are currently blocked for this message.
   * Drives the "Load images" banner visibility.
   *
   * For Spam folder: always true when body contains remote images (global toggle and allowlist ignored).
   * Otherwise true when ALL of: blockRemoteImages on, no bypass, sender not in allowlist, body has remote img.
   */
  readonly imagesBlocked = computed(() => {
    const hasRemoteImg = /<img\b[^>]+\bsrc\s*=\s*["'](?:https?:)?\/\//i.test(this.htmlBody());
    if (this.isSpamFolder() && hasRemoteImg) {
      return true;
    }
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
    return hasRemoteImg;
  });

  /**
   * Per-email "Load once" flag — set to true when the user clicks the
   * "Load images" button.  Automatically resets when the email changes.
   */
  readonly bypassBlock = signal(false);

  /** Last htmlBody value we saw; used to reset bypass only when the body actually changes. */
  private lastBodyForBypassReset: string | undefined = undefined;

  /** Timeout id for the delayed resize fallback; cleared on destroy or before scheduling a new one. */
  private resizeFallbackTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /** Last srcdoc we wrote; skip write when content unchanged to avoid redundant iframe reload. */
  private lastWrittenSrcdoc: string | undefined = undefined;

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

    // Re-render the iframe whenever the body, sender, settings, bypass, or spam folder change.
    effect(() => {
      const body = this.htmlBody();
      const blockImages = this.settingsStore.blockRemoteImages();
      const allowedSenders = this.settingsStore.allowedImageSenders();
      const bypass = this.bypassBlock();
      const sender = this.senderEmail();
      const spamFolder = this.isSpamFolder();
      const iframeElement = this.frame()?.nativeElement;
      if (iframeElement) {
        this.writeSrcdoc(iframeElement, body, blockImages, allowedSenders, sender, bypass, spamFolder);
      }
    });

    // Re-apply the max-height cap whenever the zoom level changes.
    // Reading zoomLevel() establishes the reactive dependency; the actual cap
    // calculation uses window.innerHeight directly (already zoom-adjusted).
    effect(() => {
      this.zoomService.zoomLevel();
      untracked(() => this.updateMaxIframeHeight());
    });
  }

  /** Recompute the cap from the live container height and apply it. */
  private updateMaxIframeHeight(): void {
    this.applyMaxHeight();
    this.resizeFrameToContent();
  }

  /**
   * Measure the actual scroll container (.messages-list) and compute a precise cap
   * that accounts for all non-body chrome inside the message card (header, ribbon,
   * card margin, and CSS padding). This keeps the ribbon visible without scrolling
   * at any zoom level.
   *
   * Formula (all values are live DOM measurements in CSS pixels — already zoom-adjusted):
   *
   *   cap = scrollContainer.clientHeight
   *         − messageHeader.offsetHeight
   *         − ribbon.offsetHeight
   *         − messageBody.paddingBottom   (CSS computed)
   *         − scrollContainer.paddingBottom (CSS computed)
   *         − messageCard.marginTop       (CSS computed)
   *
   * If any element is not yet in the DOM (e.g. early init before ribbon renders),
   * a 200px chrome estimate is used as a fallback. That is fine because
   * applyMaxHeight() is re-called by onMessage(), resizeFallbackTimeout, the zoom
   * effect, and window:resize — by any of those points the ribbon will be rendered.
   */
  private applyMaxHeight(): void {
    const wrapperElement = this.wrapper()?.nativeElement;
    if (!wrapperElement) {
      return;
    }

    // Walk up the DOM to the scroll container.
    const scrollContainer = wrapperElement.closest('.messages-list') as HTMLElement | null;
    const containerHeight = scrollContainer
      ? scrollContainer.clientHeight
      : window.innerHeight;

    // Locate sibling chrome elements from the message card.
    const messageCard = wrapperElement.closest('.message-card') as HTMLElement | null;
    const messageHeader = messageCard?.querySelector('.message-header') as HTMLElement | null;
    const ribbon = messageCard?.querySelector('app-email-action-ribbon') as HTMLElement | null;
    // The wrapper is a direct child of .message-body; step up to it for padding.
    const messageBody = wrapperElement.parentElement as HTMLElement | null;

    let chromeHeight: number;
    if (messageCard && messageHeader && ribbon && messageBody && scrollContainer) {
      const messageBodyPaddingBottom = parseFloat(
        getComputedStyle(messageBody).paddingBottom,
      ) || 0;
      const containerPaddingBottom = parseFloat(
        getComputedStyle(scrollContainer).paddingBottom,
      ) || 0;
      const cardMarginTop = parseFloat(
        getComputedStyle(messageCard).marginTop,
      ) || 0;
      chromeHeight =
        messageHeader.offsetHeight +
        ribbon.offsetHeight +
        messageBodyPaddingBottom +
        containerPaddingBottom +
        cardMarginTop;
    } else {
      // Fallback: ribbon not yet rendered or DOM structure not yet available.
      chromeHeight = 200;
    }

    // Small safety buffer: on some zoom/measurement combos the computed
    // measurements can be off by a few pixels (subpixel rounding, borders)
    // which can leave the ribbon nudged below the fold. Subtract a small
    // constant so the cap is a few pixels smaller than the strict sum.
    const SAFETY_BUFFER = 20; // pixels

    const cap = Math.max(120, containerHeight - chromeHeight - SAFETY_BUFFER);
    this.maxIframeHeight = cap;
    wrapperElement.style.maxHeight = `${cap}px`;
  }

  /** Re-apply the height cap when the application window is resized. */
  @HostListener('window:resize')
  onWindowResize(): void {
    this.updateMaxIframeHeight();
  }

  private readonly boundMessageHandler = (event: MessageEvent): void => this.onMessage(event);

  ngAfterViewInit(): void {
    this.applyMaxHeight();
    const iframeElement = this.frame()?.nativeElement;
    if (iframeElement) {
      this.writeSrcdoc(
        iframeElement,
        this.htmlBody(),
        this.settingsStore.blockRemoteImages(),
        this.settingsStore.allowedImageSenders(),
        this.senderEmail(),
        this.bypassBlock(),
        this.isSpamFolder(),
      );
    }
    window.addEventListener('message', this.boundMessageHandler);
  }

  ngOnDestroy(): void {
    window.removeEventListener('message', this.boundMessageHandler);
    this.clearResizeFallback();
  }

  private clearResizeFallback(): void {
    if (this.resizeFallbackTimeoutId !== null) {
      window.clearTimeout(this.resizeFallbackTimeoutId);
      this.resizeFallbackTimeoutId = null;
    }
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
    this.applyMaxHeight();
  }

  onIframeLoad(): void {
    requestAnimationFrame(() => this.resizeFrameToContent());
    this.clearResizeFallback();
    this.resizeFallbackTimeoutId = window.setTimeout(() => this.resizeFrameToContent(), 150);
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
        this.isSpamFolder(),
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
          this.isSpamFolder(),
        );
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  /**
   * Minimal sanitization for content shown in an iframe: only strip executable
   * content (scripts and event handlers). We do not use DOMPurify here so that
   * layout-related HTML/CSS (img dimensions, style attributes, tables, etc.) is
   * left intact. The iframe is same-origin so we must still remove script and
   * event handlers to prevent execution.
   */
  private minimalSanitize(html: string): string {
    let out = html;
    // Remove script tags and their content
    out = out.replace(/<script\b[\s\S]*?<\/script>/gi, '');
    // Remove event handler attributes (onclick, onerror, etc.) so no script runs
    out = out.replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, '');
    out = out.replace(/\s+on\w+\s*=\s*[^\s>]+/gi, '');
    // Remove dangerous tags (content up to closing tag; no nesting)
    const dangerousTags = ['iframe', 'object', 'embed', 'form'];
    for (const tag of dangerousTags) {
      out = out.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi'), '');
      out = out.replace(new RegExp(`<${tag}\\b[^>]*\\/?>`, 'gi'), '');
    }
    return out;
  }

  /**
   * Full DOMPurify sanitization (from parent of commit fb7a4a7). Used only for Spam folder body.
   */
  private fullSanitizeWithDOMPurify(html: string): string {
    const sanitized = DOMPurify.sanitize(html, {
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
    return sanitized.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  }

  private buildSrcdoc(
    rawBody: string,
    blockImages: boolean,
    allowedSenders: string[],
    senderEmailValue: string,
    bypass: boolean,
    isSpamFolder: boolean,
  ): string {
    const body = rawBody ?? '';
    if (!body.trim()) {
      return SRCDOC_SHELL_HEAD + SRCDOC_SHELL_TAIL;
    }

    const noScript = isSpamFolder
      ? this.fullSanitizeWithDOMPurify(body)
      : this.minimalSanitize(body);

    // Apply remote-image blocking: always for Spam; otherwise when setting is on and sender not allowed.
    const senderLower = (senderEmailValue ?? '').toLowerCase();
    const senderAllowed = senderLower
      ? allowedSenders.some((s) => s.toLowerCase() === senderLower)
      : false;
    const shouldBlockImages =
      isSpamFolder || (blockImages && !bypass && !senderAllowed);

    if (shouldBlockImages) {
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
    isSpamFolder: boolean,
  ): void {
    const srcdoc = this.buildSrcdoc(
      rawBody,
      blockImages,
      allowedSenders,
      senderEmailValue,
      bypass,
      isSpamFolder,
    );
    if (srcdoc === this.lastWrittenSrcdoc) {
      return;
    }
    this.lastWrittenSrcdoc = srcdoc;
    // Apply the cap to the wrapper proactively so it is present from the first paint,
    // before the resize postMessage arrives from the iframe.
    this.applyMaxHeight();
    iframe.srcdoc = srcdoc;
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
      this.applyMaxHeight();
    } catch {
      // Cross-origin or security restriction; leave height as-is
    }
  }
}
