/**
 * Standalone utility for resolving inline CID image references in HTML email bodies.
 *
 * Extracted from ImapService so it can be imported by both the main process and
 * worker threads (which cannot import ImapService due to heavy IMAP dependencies).
 *
 * Also exports shared type definitions used by the mail-parser worker and its
 * callers (MailParserWorkerService, ImapService).
 */

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

/** Parsed attachment metadata from simpleParser (non-inline attachments). */
export interface ParsedAttachmentMeta {
  filename: string;
  mimeType: string | null;
  size: number | null;
  contentId: string | null;
}

/**
 * Input attachment shape compatible with simpleParser's Attachment type.
 * Only the fields actually used by resolveInlineImages (and the worker) are required.
 */
export interface SimpleParserAttachment {
  filename?: string;
  contentType: string;
  size: number;
  contentId?: string | null;
  content: Buffer;
  contentDisposition?: string | null;
  headers?: unknown;
}

// ---------------------------------------------------------------------------
// Worker message types
// ---------------------------------------------------------------------------

/** Request sent from main thread to worker. */
export interface ParseRequest {
  type: 'parse';
  requestId: number;
  sourceBuffer: Buffer;
  mode: 'body' | 'text-only' | 'full';
}

/** Result for body mode: text, CID-resolved HTML, and non-inline attachment metadata. */
export interface ParseBodyResult {
  type: 'result';
  requestId: number;
  textBody: string | null;
  htmlBody: string | null;
  attachments: ParsedAttachmentMeta[];
  /** True when HTML was truncated to EMAIL_BODY_HTML_MAX_DISPLAY_CHARS before display. */
  bodyTruncated: boolean;
}

/** Result for text-only mode: text and raw HTML (no CID resolution). */
export interface ParseTextOnlyResult {
  type: 'result';
  requestId: number;
  textBody: string | null;
  htmlBody: string | null;
  bodyTruncated: boolean;
}

/** Full attachment data (content included as Buffer). */
export interface FullAttachment {
  filename: string | null | undefined;
  contentType: string;
  size: number;
  contentId: string | null | undefined;
  content: Buffer;
  contentDisposition: string | null | undefined;
}

/** Result for full mode: text, raw HTML (no CID resolution), and full attachment payloads. */
export interface ParseFullResult {
  type: 'result';
  requestId: number;
  textBody: string | null;
  htmlBody: string | null;
  fullAttachments: FullAttachment[];
}

/** Error message from worker to main thread. */
export interface ParseError {
  type: 'error';
  requestId: number;
  error: string;
}

/** Log message forwarded from worker to main thread. */
export interface LogMessage {
  type: 'log';
  level: string;
  message: string;
}

// ---------------------------------------------------------------------------
// resolveInlineImages
// ---------------------------------------------------------------------------

/**
 * Resolve inline CID image references in HTML body by replacing cid: URLs with
 * base64 data URIs, and extract non-inline attachment metadata.
 *
 * @param rawHtml - Raw HTML body from simpleParser
 * @param parsedAttachments - Attachment list from simpleParser
 * @returns Resolved HTML body and array of non-inline attachment metadata
 */
export function resolveInlineImages(
  rawHtml: string,
  parsedAttachments: SimpleParserAttachment[]
): { htmlBody: string; attachments: ParsedAttachmentMeta[] } {
  let htmlBody = rawHtml;
  const attachments: ParsedAttachmentMeta[] = [];

  // Build a map of contentId → base64 data URI for inline images.
  // Skip attachments with Content-Disposition: attachment — many email clients
  // (Outlook, Apple Mail) set Content-ID on ALL MIME parts including regular
  // file attachments.  Only true inline images (no disposition, or disposition
  // "inline") should be resolved as CID references.
  const cidMap = new Map<string, string>();
  for (const att of parsedAttachments) {
    if (att.contentId && att.contentDisposition !== 'attachment') {
      // Normalize: strip angle brackets from content IDs (RFC 2392)
      const cid = att.contentId.replace(/^<|>$/g, '');
      if (cid && att.content && att.content.length > 0) {
        const mimeType = att.contentType || 'application/octet-stream';
        const base64 = att.content.toString('base64');
        cidMap.set(cid, `data:${mimeType};base64,${base64}`);
      }
    }
  }

  // Replace cid: references in HTML with data URIs
  if (cidMap.size > 0 && htmlBody) {
    htmlBody = htmlBody.replace(/cid:([^\s"'>]+)/gi, (_match, cidRef) => {
      const resolved = cidMap.get(cidRef);
      return resolved || `cid:${cidRef}`;
    });
  }

  // Collect non-inline attachment metadata
  for (const att of parsedAttachments) {
    // Skip inline images that are referenced in the HTML body
    const isInline = att.contentId && cidMap.has(att.contentId.replace(/^<|>$/g, ''));
    if (isInline) {
      continue;
    }
    // Skip attachments with no filename (usually inline content-type parts)
    const filename = att.filename || att.contentType?.split('/').pop() || 'attachment';
    attachments.push({
      filename,
      mimeType: att.contentType || null,
      size: att.size || (att.content ? att.content.length : null),
      contentId: att.contentId ? att.contentId.replace(/^<|>$/g, '') : null,
    });
  }

  return { htmlBody, attachments };
}
